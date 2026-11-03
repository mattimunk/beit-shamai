# Deploying Beit Shamai (Israeli region)

The server must run **in Israel**: the Tax Authority deals (via GovMap) only answer Israeli IP addresses. One small virtual machine runs everything: the web app, the API, the nightly data jobs, HTTPS and daily backups.

**Recommended:** Google Cloud, region `me-west1` (Tel Aviv), machine `e2-small` (2 vCPU burst, 2 GB RAM), 30 GB disk. That's roughly US$15–20 a month. AWS `il-central-1` (Tel Aviv) works the same way, with an EC2 `t3.small` and Ubuntu.

## 1. Create the server (Google Cloud, about 10 minutes)

1. Sign in at **console.cloud.google.com** and create a project (e.g. `beit-shamai`). Enable billing.
2. Go to **Compute Engine → VM instances → Create instance**.
   - Name: `beit-shamai`
   - Region: **me-west1 (Tel Aviv)**, any zone
   - Machine type: **e2-small**
   - Boot disk: **Ubuntu 24.04 LTS**, 30 GB
   - Firewall: tick **Allow HTTP traffic** and **Allow HTTPS traffic**
3. Click **Create**. Note the **External IP**.
4. Optional but recommended: **VPC network → IP addresses**, then reserve the VM's external IP as **static**, so it never changes.

## 2. Install the app (about 5 minutes)

1. In the VM list, click **SSH** next to the server. A terminal opens in the browser.
2. Paste:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/mattimunk/beit-shamai/main/deploy/setup-vm.sh | bash
   ```
   This installs Docker, downloads the code, creates `.env` with a random admin password, builds and starts. It ends by printing `{"ok":true,...}`.
3. Open `http://<External IP>` in your browser: the app loads. The **Demo data / Live data** switch appears because it's talking to the server.

> If the repository is private, first create a GitHub deploy key or a personal access token, and clone with it. Otherwise make the repo public, or ask Claude to adjust the script.

## 3. Check the data sources (2 minutes)

In the same SSH terminal:

```bash
cd beit-shamai
sudo docker compose exec app bun run server/probe.ts
```

It prints PASS / FAIL for each source and saves the raw responses in `tests/fixtures/live/` inside the container. Copy the output (and, if asked, the saved files) back to Claude so the field mappings can be locked in:

```bash
sudo docker compose cp app:/app/tests/fixtures/live ./live-fixtures && tar czf live-fixtures.tgz live-fixtures
```

**If "GovMap deals" FAILS with 403 or a timeout but other sources pass,** the Tax Authority is refusing cloud (data-centre) addresses. Put an Israeli ISP proxy in `.env` as `DEALS_PROXY=http://user:pass@host:port`, then run `sudo docker compose up -d`. Alternatively, run the deals job from a small machine on an Israeli office line.

## Loading sales data from a file

Until a data arrangement for automated sales access is in place, load completed deals from a CSV (from a licensed vendor, a Tax Authority data request, or an appraiser's records):

```bash
TOKEN=$(grep ADMIN_TOKEN .env | cut -d= -f2)
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: text/csv" \
  --data-binary @deals.csv "localhost/api/deals/import?source=vendor-name"
```

Columns, in Hebrew or English: תאריך עסקה (date), מחיר (price), ישוב (city), רחוב (street), מספר בית (number), גוש/חלקה/תת חלקה (block/parcel/sub-parcel), שטח (area), חדרים (rooms), קומה (floor), קומות בבניין, שנת בנייה. Missing coordinates are looked up automatically. Then run the matching job for the city.

## 4. Choose the cities

Edit `config/sources.json` (`nano config/sources.json`). Each city needs its name as written in Tax Authority records, a centre point, a radius and its CBS district:

```json
{ "name": "תל אביב יפו", "lat": 32.0853, "lng": 34.7818, "radiusM": 4000, "district": "tel_aviv" }
```

Districts: `jerusalem`, `north`, `haifa`, `center`, `tel_aviv`, `south`. Then restart with `sudo docker compose up -d`.

Run the first load straight away instead of waiting for the night. Replace TOKEN with the value in `.env`:

```bash
TOKEN=$(grep ADMIN_TOKEN .env | cut -d= -f2)
for job in gtfs cbs; do curl -s -X POST -H "Authorization: Bearer $TOKEN" localhost/api/jobs/$job; echo; done
for job in deals match renewal; do curl -s -X POST -H "Authorization: Bearer $TOKEN" -d '{"city":"תל אביב יפו"}' localhost/api/jobs/$job; echo; done
```

GTFS takes a few minutes; it's the whole country's timetable.

## 5. Domain and HTTPS

1. At your domain registrar, add an **A record**, e.g. `app.yourdomain.co.il` → the server's External IP.
2. In `.env`, set `DOMAIN=app.yourdomain.co.il`, then run `sudo docker compose up -d`.
3. Caddy obtains a Let's Encrypt certificate automatically within a minute. The site is then on `https://app.yourdomain.co.il`.

## What runs automatically

| When (UTC) | Job | Notes |
| --- | --- | --- |
| Nightly, 00:00 | Deals sync and advert↔deal matching, per city | Tax Authority via GovMap |
| Daily, 01:00 | Database backup | `/data/backups`, last 14 kept |
| Sunday | GTFS timetable, stops and peak frequencies | National Public Transport Authority |
| Monday | Renewal complexes and renewal plans, per city | Planning Administration and Urban Renewal Authority layers |
| Monthly, from the 17th | CBS dwelling price index | One series per district |

A failing source is retried after 6 hours and never blocks the others.

## Monitoring

- `https://<your domain>/health` lists every source with its last successful run, `stale: true` when overdue, and the last error.
- Free uptime alerts: in Google Cloud go to **Monitoring → Uptime checks → Create**, enter the `/health` URL, and add your email for alerts. UptimeRobot works the same way.

## Updating to a new version

```bash
cd beit-shamai && ./deploy/update.sh
```

Data lives in the Docker volume `appdata` and survives updates. For off-site backups, copy `/data/backups` to a Cloud Storage bucket. That's one `gsutil rsync` line in cron, and Claude can add it.

## Parcel layer

Tax Authority deals are placed on the map from the Survey of Israel's national parcel layer
(data.gov.il). The server downloads it monthly. To load it now:

```bash
sudo docker compose exec app bun run server/importParcels.ts
```

If data.gov.il refuses the server (403), download it yourself and hand it over:

1. In your browser, open
   `https://data.gov.il/dataset/dff8a168-af6c-4e0f-bbe3-c4bd3646084c` and download
   **parcel_all.zip** (about 640 MB).
2. In the Google Cloud SSH window, click **Upload file** (top right) and choose the zip. It
   lands in your home folder.
3. Then:
   ```bash
   cd ~/beit-shamai
   sudo docker compose cp ~/parcel_all.zip app:/data/parcel_all.zip
   sudo docker compose exec app bun run server/importParcels.ts /data/parcel_all.zip
   rm ~/parcel_all.zip
   ```

## Listing feeds

When a Yad2 / Madlan / agency feed is licensed, it is pushed to `POST /api/listings/import` with the admin token, in the format described in `server/ledger.ts`. Send a full daily snapshot per city (`"snapshot": {"city": "..."}`), so adverts that disappear are marked removed. That's how the system learns what sold.
