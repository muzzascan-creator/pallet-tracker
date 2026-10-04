# Pallet Tracker

Tracks pallets owed to you by customers. Operators scan a customer's barcode with a phone, see the
balance, and record pallets delivered and picked up. Admins see balances, manage customers and
logins, and run reports.

## Run it

Needs Node.js 22.13 or newer (nothing else to install).

```
npm start                 # http://localhost:3000
npm run demo-data         # optional: sample customers + operators dave/sam (password pallets1)
```

First start creates login `admin` / `admin` (or `ADMIN_PASSWORD` env var); you're asked to change it.
Data lives in `data/pallets.db` (one SQLite file). Back up that file to back up everything.

Settings (env vars): `PORT`, `DATA_DIR`, `ADMIN_PASSWORD` (first run only).

## Phone camera

Browsers only allow the camera on **https** pages (or `localhost`). Host the app behind https
(any host with a persistent disk, or a tunnel such as Cloudflare Tunnel for testing).
If scanning isn't possible, operators can type a code or search by name.

## How balances work

Every entry is a line in a ledger:
- Delivered: customer owes you **more** (+)
- Picked up: customer owes you **less** (−)
- Adjustment (admin only, needs a reason): opening balances, stocktake corrections

Balance = sum of all non-cancelled lines. Entries are never deleted; they're cancelled with a reason,
so history stays auditable. Only admins can cancel entries.

## Master file import

Customers → Import master file accepts .xlsx, .xls or .csv with a heading row. Columns are matched
by heading (code/barcode, name, address, phone, email, notes, opening balance) and can be changed
before importing. Existing codes are updated, new codes are added, nothing is deleted.
`sample-master-file.csv` shows the layout. The **code** column must match what the barcode contains;
Customers → Print barcode labels prints Code 128 labels if customers don't have barcodes yet.

## Files

- `server.js`: web server + API (roles: admin, operator)
- `db.js`: database schema
- `public/`: the web app (plain HTML/CSS/JS; scanner, barcode and Excel libraries in `public/vendor`)
- `seed-demo.js`: demo data
