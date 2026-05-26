# CSV Import

## When to use

Use this when an admin or partner has CSV import failures or needs help formatting a bulk location file.

## Customer reply

Hi {{owner_name}},

The CSV import accepts up to 100 locations per file. Please use the template and make sure each row includes `name` and `placeId`. If only some rows failed, the successful rows are already imported; correct the failed rows and upload a new file with those locations.

## Internal checks

- Confirm the account ID is correct.
- Check row-level errors in the import report.
- Verify the file has no more than 100 data rows.
- Confirm required headers are `name` and `placeId`.
- Check account quota before retrying failed rows.

## Escalation

Escalate if row validation passes but location creation fails, if account quota looks wrong, or if the import writes partial account state without an audit log.
