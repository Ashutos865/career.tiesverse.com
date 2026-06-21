# Migrate Apps Script Data To Cloudflare

This moves old Google Sheet candidate rows into Cloudflare D1 and old Drive resumes into Cloudflare R2.

## Export The Sheet

Export the Apps Script spreadsheet's `Master` sheet as CSV and save it to:

```text
backend/migration/Master.csv
```

## Export Resumes From Drive

Download the old `TV_Resumes` Drive folder and place its files in:

```text
backend/migration/resumes/
```

The migration matches files using the Drive file ID from `resume_link`, then candidate name or email.

## Apply The D1 Schema

```powershell
cd backend
$env:PYTHONPATH=(Resolve-Path .deps)
python scripts/init_cloudflare_d1.py
```

## Run The Migration

```powershell
cd backend
$env:PYTHONPATH=(Resolve-Path .deps)
python scripts/migrate_appscript_to_cloudflare.py
```

Rows with an existing `request_id` are skipped, so the migration is safe to rerun.

## Auto-Migrate From Apps Script

The Apps Script source is located at:

```text
backend/apps-script/TIESVERSE_Master_Backend_v2.gs
```

Set the Cloudflare values in Apps Script's **Project Settings -> Script properties**, then run:

```text
startCloudflareMigration
```

Check progress with:

```text
getCloudflareMigrationStatus
```

Stop it with:

```text
stopCloudflareMigration
```

The automated migration sends form settings and candidate rows to D1 and resume files to R2.

## Notes

- The migration does not delete Google Sheets or Drive data.
- Keep `backend/migration/` private because it contains candidate information.
