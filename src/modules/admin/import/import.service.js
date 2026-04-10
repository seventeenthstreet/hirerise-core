/**
 * File: src/modules/admin/import/import.service.js
 */

async function importFromCSV({
  buffer,
  datasetType,
  adminId,
  agency = null,
}) {
  if (!SUPPORTED_TYPES.includes(datasetType)) {
    throw new AppError(
      `Unsupported datasetType "${datasetType}". Supported: ${SUPPORTED_TYPES.join(', ')}`,
      400,
      { datasetType, supported: SUPPORTED_TYPES },
      ErrorCodes.VALIDATION_ERROR
    );
  }

  let rows;

  try {
    rows = parseCSVBuffer(buffer);
  } catch (err) {
    if (err.isOperational) throw err;

    throw new AppError(
      `Failed to parse CSV: ${err.message}`,
      400,
      null,
      ErrorCodes.VALIDATION_ERROR
    );
  }

  logger.info('[CsvImport] CSV parsed', {
    datasetType,
    rowCount: rows.length,
    adminId,
    agency,
  });

  const result = await processImport({
    datasetType,
    rows,
    adminId,
    agency,
  });

  const rowsProcessed = result.total ?? rows.length;
  const rowsImported = result.inserted ?? 0;
  const rowsSkipped = result.skipped ?? 0;
  const rowsFailed = Array.isArray(result.errors)
    ? result.errors.length
    : 0;

  return {
    // canonical schema-aligned fields
    rows_processed: rowsProcessed,
    rows_imported: rowsImported,
    rows_skipped: rowsSkipped,
    rows_failed: rowsFailed,

    // backward compatibility
    processed: rowsProcessed,
    created: rowsImported,
    duplicates: result.duplicates?.length ?? 0,
    skipped: rowsSkipped,
    errors: result.errors ?? [],
    detail: result.duplicates ?? [],
  };
}