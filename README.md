# Dell IPMI Fan Service

A simple service that controls fan speeds on Dell servers using IPMI. Has a web interface where you can set up rules or use a formula to automatically adjust fans based on temperature.

## Quick start

You'll need: Rust, Node.js, and `ipmitool` installed on your machine.

```bash
# Build the frontend first
cd frontend
npm install
npm run build
cd ..

# Build and run the service
cargo run
```

Then open http://localhost:8080 in your browser.

**Default login:** `admin` / `password` — change this right away via the settings page.

## Setting up fan control

**Formula** — Write a tiny math expression using `t` for temperature. For example:
- `t * 2 + 20` — fan speed scales linearly with temp
- `max(30, t - 10)` — minimum 30% speed, otherwise just below temp

The service checks your settings every few seconds (configurable) and adjusts accordingly.

## Permissions

You'll need to run this as root or have IPMI permissions, since it uses `ipmitool` to talk to the BMC.