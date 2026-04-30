use axum::{
    body::Body,
    extract::{State, Request},
    http::{header, HeaderValue, Response, StatusCode, Uri},
    middleware::{self, Next},
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use sqlx::{sqlite::SqlitePool, Pool, Sqlite};
use tokio::process::Command;
use tokio::time::{sleep, Duration};
use tracing::info;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use rust_embed::Embed;

#[derive(Embed)]
#[folder = "frontend/dist"]
struct Assets;

#[allow(dead_code)]
#[derive(sqlx::FromRow)]
struct User {
    pub username: String,
    pub password_hash: String,
}

#[derive(Serialize, Deserialize, Clone, sqlx::FromRow)]
pub struct Settings {
    pub id: i32,
    pub polling_interval: i32,
    pub formula: String,
}

#[derive(Serialize, Deserialize, Clone, sqlx::FromRow)]
pub struct Rule {
    pub id: String,
    pub temp: i32,
    pub speed: i32,
}

#[derive(Serialize, Deserialize, sqlx::FromRow, Clone)]
pub struct Telemetry {
    pub temp: i32,
    pub speed: i32,
    pub timestamp: String,
}

#[derive(Deserialize)]
pub struct ChangePassword {
    pub new_password: String,
}

#[derive(Serialize, Clone)]
pub struct FanReading {
    pub name: String,
    pub rpm: i32,
}

#[derive(Serialize, Clone)]
pub struct SdrSnapshot {
    pub inlet_temp: Option<i32>,
    pub exhaust_temp: Option<i32>,
    pub fans: Vec<FanReading>,
    pub power_watts: Option<i32>,
}

type Db = Pool<Sqlite>;

// --- Auth ---

async fn auth(
    State(pool): State<Db>,
    req: Request,
    next: Next,
) -> Result<impl IntoResponse, Response<Body>> {
    let auth_header = req.headers()
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok());

    let mut authenticated = false;

    if let Some(auth_str) = auth_header {
        if auth_str.starts_with("Basic ") {
            let encoded = &auth_str[6..];
            if let Ok(decoded_bytes) = BASE64.decode(encoded) {
                if let Ok(decoded) = String::from_utf8(decoded_bytes) {
                    if let Some((user, pass)) = decoded.split_once(':') {
                        let user_match = sqlx::query_as::<_, User>(
                            "SELECT username, password_hash FROM users WHERE username = ? AND password_hash = ?"
                        )
                        .bind(user)
                        .bind(pass)
                        .fetch_optional(&pool)
                        .await;

                        if let Ok(Some(_)) = user_match {
                            authenticated = true;
                        }
                    }
                }
            }
        }
    }

    if authenticated {
        Ok(next.run(req).await)
    } else {
        let response = Response::builder()
            .status(StatusCode::UNAUTHORIZED)
            .header(header::WWW_AUTHENTICATE, "Basic realm=\"Dell Fan Control\"")
            .body(Body::from("Unauthorized"))
            .unwrap();
        Err(response)
    }
}

// --- IPMI ---

async fn ipmi_exec(args: &[&str]) -> Result<String, String> {
    let out = Command::new("ipmitool")
        .args(args)
        .output()
        .await
        .map_err(|e| format!("ipmitool launch failed: {}", e))?;

    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).to_string())
    }
}

// --- SDR Parser ---

fn parse_sdr(output: &str) -> SdrSnapshot {
    let mut inlet_temp = None;
    let mut exhaust_temp = None;
    let mut fans = Vec::new();
    let mut power_watts = None;

    for line in output.lines() {
        let parts: Vec<&str> = line.splitn(3, '|').map(|s| s.trim()).collect();
        if parts.len() < 2 {
            continue;
        }
        let name = parts[0];
        let value = parts[1];

        if name == "Inlet Temp" {
            inlet_temp = value.split_whitespace().next().and_then(|v| v.parse().ok());
        } else if name == "Temp" {
            exhaust_temp = value.split_whitespace().next().and_then(|v| v.parse().ok());
        } else if name.starts_with("Fan") && value.contains("RPM") {
            if let Some(rpm) = value.split_whitespace().next().and_then(|v| v.parse().ok()) {
                fans.push(FanReading { name: name.to_string(), rpm });
            }
        } else if name == "Pwr Consumption" && value.contains("Watts") {
            power_watts = value.split_whitespace().next().and_then(|v| v.parse().ok());
        }
    }

    fans.sort_by(|a, b| a.name.cmp(&b.name));
    SdrSnapshot { inlet_temp, exhaust_temp, fans, power_watts }
}

// --- Formula Eval (server-side, mirrors frontend mathjs) ---
// Supports basic expressions with variable t using a simple evaluator.
// We shell out to avoid pulling in a full JS engine — just do the math in Rust.

fn eval_formula(formula: &str, t: i32) -> Option<i32> {
    // Replace 't' with the numeric value and evaluate via bc-style parsing.
    // We use a minimal recursive descent parser for safety.
    let expr = formula.replace('t', &t.to_string());
    eval_expr(expr.trim()).map(|v| v.round() as i32)
}

fn eval_expr(s: &str) -> Option<f64> {
    let s = s.trim();
    // Handle max(a, b) and min(a, b)
    if s.starts_with("max(") && s.ends_with(')') {
        let inner = &s[4..s.len()-1];
        let (a, b) = split_args(inner)?;
        return Some(eval_expr(a)?.max(eval_expr(b)?));
    }
    if s.starts_with("min(") && s.ends_with(')') {
        let inner = &s[4..s.len()-1];
        let (a, b) = split_args(inner)?;
        return Some(eval_expr(a)?.min(eval_expr(b)?));
    }
    // Handle parentheses
    if s.starts_with('(') && s.ends_with(')') {
        return eval_expr(&s[1..s.len()-1]);
    }
    // Find lowest-precedence operator outside parens (+ or -)
    if let Some(v) = find_op(s, &['+', '-']) {
        let (l, op, r) = v;
        return match op {
            '+' => Some(eval_expr(l)? + eval_expr(r)?),
            '-' => Some(eval_expr(l)? - eval_expr(r)?),
            _ => None,
        };
    }
    // Find * or /
    if let Some(v) = find_op(s, &['*', '/']) {
        let (l, op, r) = v;
        return match op {
            '*' => Some(eval_expr(l)? * eval_expr(r)?),
            '/' => { let d = eval_expr(r)?; if d == 0.0 { None } else { Some(eval_expr(l)? / d) } }
            _ => None,
        };
    }
    // Parse number
    s.parse::<f64>().ok()
}

fn split_args(s: &str) -> Option<(&str, &str)> {
    let mut depth = 0i32;
    for (i, c) in s.char_indices() {
        match c {
            '(' => depth += 1,
            ')' => depth -= 1,
            ',' if depth == 0 => return Some((&s[..i], &s[i+1..])),
            _ => {}
        }
    }
    None
}

fn find_op<'a>(s: &'a str, ops: &[char]) -> Option<(&'a str, char, &'a str)> {
    let mut depth = 0i32;
    let bytes = s.as_bytes();
    // Scan right-to-left for left-associativity
    let mut i = s.len();
    while i > 0 {
        i -= 1;
        match bytes[i] {
            b')' => depth += 1,
            b'(' => depth -= 1,
            c if depth == 0 => {
                let ch = c as char;
                if ops.contains(&ch) {
                    // Don't treat leading minus as binary op
                    if i == 0 { continue; }
                    return Some((&s[..i], ch, &s[i+1..]));
                }
            }
            _ => {}
        }
    }
    None
}

fn calculate_speed(t: i32, formula: &str, rules: &[Rule]) -> i32 {
    if !formula.trim().is_empty() {
        if let Some(v) = eval_formula(formula, t) {
            return v.max(0).min(100);
        }
    }
    // Fall back to step rules
    rules.iter().find(|r| t >= r.temp).map(|r| r.speed).unwrap_or(20)
}

// --- Worker ---

async fn worker_loop(pool: Db) {
    info!("Thermal worker started");
    loop {
        let settings = sqlx::query_as::<_, Settings>(
            "SELECT id, polling_interval, formula FROM settings WHERE id = 1"
        )
        .fetch_one(&pool)
        .await;

        if let Ok(s) = settings {
            let result: Result<(), String> = async {
                let sdr_output = ipmi_exec(&["sdr", "list"]).await?;
                let snapshot = parse_sdr(&sdr_output);

                // Use exhaust temp as control variable — it reflects actual server heat
                let temp = snapshot.exhaust_temp
                    .ok_or_else(|| "No exhaust temperature reading".to_string())?;

                let rules = sqlx::query_as::<_, Rule>(
                    "SELECT id, temp, speed FROM rules ORDER BY temp DESC"
                )
                .fetch_all(&pool)
                .await
                .map_err(|e| e.to_string())?;

                let speed = calculate_speed(temp, &s.formula, &rules);

                ipmi_exec(&["raw", "0x30", "0x30", "0x01", "0x00"]).await?;
                let hex_speed = format!("0x{:02x}", speed);
                ipmi_exec(&["raw", "0x30", "0x30", "0x02", "0xff", &hex_speed]).await?;

                sqlx::query("INSERT INTO telemetry (temp, speed) VALUES (?, ?)")
                    .bind(temp)
                    .bind(speed)
                    .execute(&pool)
                    .await
                    .ok();

                info!(
                    "Inlet: {}°C  Exhaust: {}°C  ->  Fan: {}%  Power: {}W",
                    snapshot.inlet_temp.unwrap_or(0),
                    temp,
                    speed,
                    snapshot.power_watts.unwrap_or(0)
                );
                Ok(())
            }.await;

            if let Err(e) = result {
                info!("Thermal worker error: {}", e);
            }

            sleep(Duration::from_secs(s.polling_interval as u64)).await;
        } else {
            info!("Could not read settings, retrying in 5s");
            sleep(Duration::from_secs(5)).await;
        }
    }
}

// --- API Handlers ---

async fn get_rules(State(pool): State<Db>) -> Result<Json<Vec<Rule>>, StatusCode> {
    sqlx::query_as::<_, Rule>("SELECT id, temp, speed FROM rules")
        .fetch_all(&pool).await.map(Json).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

async fn save_rules(State(pool): State<Db>, Json(rules): Json<Vec<Rule>>) -> StatusCode {
    let mut tx = match pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR,
    };
    if sqlx::query("DELETE FROM rules").execute(&mut *tx).await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR;
    }
    for r in rules {
        if sqlx::query("INSERT INTO rules (id, temp, speed) VALUES (?, ?, ?)")
            .bind(r.id).bind(r.temp).bind(r.speed)
            .execute(&mut *tx).await.is_err()
        {
            return StatusCode::INTERNAL_SERVER_ERROR;
        }
    }
    if tx.commit().await.is_ok() { StatusCode::OK } else { StatusCode::INTERNAL_SERVER_ERROR }
}

async fn get_settings(State(pool): State<Db>) -> Result<Json<Settings>, StatusCode> {
    sqlx::query_as::<_, Settings>("SELECT id, polling_interval, formula FROM settings WHERE id = 1")
        .fetch_one(&pool).await.map(Json).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

async fn save_settings(State(pool): State<Db>, Json(s): Json<Settings>) -> StatusCode {
    let result = sqlx::query("UPDATE settings SET polling_interval = ?, formula = ? WHERE id = 1")
        .bind(s.polling_interval)
        .bind(s.formula)
        .execute(&pool).await;
    if result.is_ok() { StatusCode::OK } else { StatusCode::INTERNAL_SERVER_ERROR }
}

async fn get_telemetry(State(pool): State<Db>) -> Result<Json<Vec<Telemetry>>, StatusCode> {
    sqlx::query_as::<_, Telemetry>(
        "SELECT temp, speed, timestamp FROM telemetry ORDER BY timestamp DESC LIMIT 100"
    )
    .fetch_all(&pool).await.map(Json).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

async fn get_sdr() -> Result<Json<SdrSnapshot>, StatusCode> {
    match ipmi_exec(&["sdr", "list"]).await {
        Ok(output) => Ok(Json(parse_sdr(&output))),
        Err(_) => Err(StatusCode::INTERNAL_SERVER_ERROR),
    }
}

async fn change_password(State(pool): State<Db>, Json(body): Json<ChangePassword>) -> StatusCode {
    if body.new_password.trim().is_empty() {
        return StatusCode::BAD_REQUEST;
    }
    let result = sqlx::query("UPDATE users SET password_hash = ? WHERE username = 'admin'")
        .bind(&body.new_password)
        .execute(&pool).await;
    if result.is_ok() {
        info!("Admin password updated");
        StatusCode::OK
    } else {
        StatusCode::INTERNAL_SERVER_ERROR
    }
}

// --- Static Files ---

async fn static_handler(uri: Uri) -> impl IntoResponse {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };

    match Assets::get(path) {
        Some(content) => {
            let mime = mime_guess::from_path(path).first_or_octet_stream();
            Response::builder()
                .status(StatusCode::OK)
                .header(
                    header::CONTENT_TYPE,
                    HeaderValue::from_str(mime.as_ref())
                        .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
                )
                .body(Body::from(content.data))
                .unwrap()
        }
        None => match Assets::get("index.html") {
            Some(index) => Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "text/html")
                .body(Body::from(index.data))
                .unwrap(),
            None => Response::builder()
                .status(StatusCode::NOT_FOUND)
                .body(Body::from("404 Not Found"))
                .unwrap(),
        },
    }
}

// --- Main ---

#[tokio::main]
async fn main() {
    tracing_subscriber::registry()
        .with(tracing_subscriber::fmt::layer())
        .init();

    let pool = SqlitePool::connect("sqlite:main.db?mode=rwc")
        .await
        .expect("Failed to connect to database");

    info!("Database connected");

    sqlx::query("CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password_hash TEXT)")
        .execute(&pool).await.unwrap();
    sqlx::query("CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY, polling_interval INTEGER DEFAULT 5, formula TEXT DEFAULT '')")
        .execute(&pool).await.unwrap();
    // Migrate: add formula column if it doesn't exist yet
    let _ = sqlx::query("ALTER TABLE settings ADD COLUMN formula TEXT DEFAULT ''")
        .execute(&pool).await;
    sqlx::query("CREATE TABLE IF NOT EXISTS rules (id TEXT PRIMARY KEY, temp INTEGER, speed INTEGER)")
        .execute(&pool).await.unwrap();
    sqlx::query("CREATE TABLE IF NOT EXISTS telemetry (temp INTEGER, speed INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)")
        .execute(&pool).await.unwrap();

    sqlx::query("INSERT OR IGNORE INTO users (username, password_hash) VALUES ('admin', 'password')")
        .execute(&pool).await.unwrap();
    sqlx::query("INSERT OR IGNORE INTO settings (id, polling_interval, formula) VALUES (1, 5, '')")
        .execute(&pool).await.unwrap();

    info!("Database ready");

    let worker_pool = pool.clone();
    tokio::spawn(async move { worker_loop(worker_pool).await; });

    let api_routes = Router::new()
        .route("/rules",          get(get_rules).post(save_rules))
        .route("/settings",       get(get_settings).post(save_settings))
        .route("/telemetry",      get(get_telemetry))
        .route("/sdr",            get(get_sdr))
        .route("/auth/password",  axum::routing::post(change_password))
        .layer(middleware::from_fn_with_state(pool.clone(), auth));

    let app = Router::new()
        .nest("/api", api_routes)
        .fallback(static_handler)
        .with_state(pool);

    let listener = tokio::net::TcpListener::bind("0.0.0.0:8080").await.unwrap();
    info!("Server running at http://0.0.0.0:8080");
    axum::serve(listener, app).await.unwrap();
}