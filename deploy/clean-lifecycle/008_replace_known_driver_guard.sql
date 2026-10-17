-- ONLY inside the reviewed Root atomic reset after exact old-manifest match.
-- No legacy operation, checkpoint, function or authority is overwritten.
DROP TRIGGER driver_account_erasure_receipt_guard ON public.driver_measurement_receipts;
