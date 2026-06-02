export interface ClientCsvValidationError {
  row: number;
  reason: string;
}

export function validateLocationsCsvClient(
  rows: Array<Record<string, string>>,
): ClientCsvValidationError[] {
  const failures: ClientCsvValidationError[] = [];
  if (rows.length > 100) {
    failures.push({ row: 0, reason: 'CSV contains more than 100 data rows.' });
  }
  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    if (!row.name?.trim()) failures.push({ row: rowNumber, reason: 'Missing name.' });
    if (!row.placeId?.trim()) failures.push({ row: rowNumber, reason: 'Missing placeId.' });
  });
  return failures;
}
