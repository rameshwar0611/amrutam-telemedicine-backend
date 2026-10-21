import { createHash } from 'node:crypto';
import type { RefundAdapter } from '../../modules/payments/domain/ports.js';
export class DeterministicFakeRefundAdapter implements RefundAdapter {
  refund(input: Parameters<RefundAdapter['refund']>[0]) {
    // No transfer or external network: duplicate calls across processes give one logical reference.
    const reference =
      'fake_refund_' + createHash('sha256').update(JSON.stringify(input)).digest('hex');
    return Promise.resolve({ reference });
  }
}
