import { z } from 'zod';
import { ParsedSettlementRecord, SettlementType } from '../types/index.js';

export const CSVRecordSchema = z.object({
  settlement_id: z.string().trim().min(1, 'settlement_id is required'),
  lifecycle_id: z.string().trim().optional().transform(val => val && val.length > 0 ? val : null),
  account_id: z.string().trim().min(1, 'account_id is required'),
  merchant_name: z.string().trim().min(1, 'merchant_name is required'),
  transaction_date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'transaction_date must be YYYY-MM-DD'),
  settlement_date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'settlement_date must be YYYY-MM-DD'),
  settlement_amount: z.string().trim().refine(val => {
    const num = parseFloat(val);
    return !isNaN(num) && num > 0;
  }, 'settlement_amount must be a positive number'),
  settlement_type: z.enum(['DEBIT', 'CREDIT'], {
    errorMap: () => ({ message: "settlement_type must be 'DEBIT' or 'CREDIT'" })
  }),
  currency: z.string().trim().min(1, 'currency is required')
});

export function validateAndTransformCSVRecord(raw: any, rowNumber: number): {
  success: boolean;
  data?: ParsedSettlementRecord;
  error?: string;
} {
  const result = CSVRecordSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ');
    return {
      success: false,
      error: `Row ${rowNumber}: ${issues}`
    };
  }

  const valid = result.data;
  return {
    success: true,
    data: {
      settlement_id: valid.settlement_id,
      lifecycle_id: valid.lifecycle_id ?? null,
      account_id: valid.account_id,
      merchant_name: valid.merchant_name,
      transaction_date: valid.transaction_date,
      settlement_date: valid.settlement_date,
      settlement_amount: parseFloat(parseFloat(valid.settlement_amount).toFixed(2)),
      settlement_type: valid.settlement_type as SettlementType,
      currency: valid.currency.toUpperCase()
    }
  };
}
