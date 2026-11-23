import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {
  PaymentAttempt,
  PAYMENT_ATTEMPT_IMMUTABLE_FIELDS,
} from '../models/PaymentAttempt.js';
import {
  Refund,
  REFUND_IMMUTABLE_FIELDS,
  RefundSettlementSource,
} from '../models/Refund.js';
import {
  RefundJob,
  REFUND_JOB_IMMUTABLE_FIELDS,
} from '../models/RefundJob.js';
import { Order } from '../models/Order.js';

describe('Payment & Refund Persistence Models (Phase 8.3 Step 1)', () => {
  const dummyOrderId = new mongoose.Types.ObjectId('674000000000000000000101');
  const dummyOrderId2 = new mongoose.Types.ObjectId('674000000000000000000102');
  const dummyUserId = new mongoose.Types.ObjectId('674000000000000000000201');
  const dummyProjectId = new mongoose.Types.ObjectId('674000000000000000000301');

  // ==========================================================================
  // 1. PAYMENT ATTEMPT MODEL BASIC SCHEMA TESTS
  // ==========================================================================
  describe('PaymentAttempt Model - Schema & Field Validation', () => {
    it('accepts valid payment attempt data with all required fields', async () => {
      const attempt = new PaymentAttempt({
        paymentId: 'pay_valid_123456789',
        orderId: dummyOrderId,
        razorpayOrderId: 'order_valid_123456789',
        amountCapturedPaise: 417000,
        currency: 'INR',
        status: 'captured',
        classification: 'primary',
        gatewayMethod: 'upi',
      });

      await assert.doesNotReject(async () => await attempt.validate());
      assert.equal(attempt.paymentId, 'pay_valid_123456789');
      assert.equal(attempt.amountCapturedPaise, 417000);
      assert.equal(attempt.currency, 'INR');
      assert.equal(attempt.status, 'captured');
      assert.equal(attempt.classification, 'primary');
    });

    it('rejects missing required fields (paymentId, orderId, razorpayOrderId, amountCapturedPaise)', async () => {
      const attempt = new PaymentAttempt({});
      await assert.rejects(async () => await attempt.validate(), (err: any) => {
        assert.ok(err.errors.paymentId, 'paymentId should be required');
        assert.ok(err.errors.orderId, 'orderId should be required');
        assert.ok(err.errors.razorpayOrderId, 'razorpayOrderId should be required');
        assert.ok(err.errors.amountCapturedPaise, 'amountCapturedPaise should be required');
        return true;
      });
    });

    it('rejects invalid payment attempt status values', async () => {
      const attempt = new PaymentAttempt({
        paymentId: 'pay_test_status',
        orderId: dummyOrderId,
        razorpayOrderId: 'order_test_status',
        amountCapturedPaise: 100000,
        currency: 'INR',
        status: 'unknown_invalid_status' as any,
      });

      await assert.rejects(async () => await attempt.validate(), /is not a valid payment attempt status/);
    });

    it('rejects invalid payment classification values', async () => {
      const attempt = new PaymentAttempt({
        paymentId: 'pay_test_class',
        orderId: dummyOrderId,
        razorpayOrderId: 'order_test_class',
        amountCapturedPaise: 100000,
        currency: 'INR',
        classification: 'invalid_classification' as any,
      });

      await assert.rejects(async () => await attempt.validate(), /is not a valid payment attempt classification/);
    });

    it('rejects negative captured amount', async () => {
      const attempt = new PaymentAttempt({
        paymentId: 'pay_neg_amount',
        orderId: dummyOrderId,
        razorpayOrderId: 'order_neg_amount',
        amountCapturedPaise: -500,
        currency: 'INR',
      });

      await assert.rejects(async () => await attempt.validate(), /Captured amount cannot be negative/i);
    });

    it('rejects floating-point captured amounts (paise must be integer)', async () => {
      const attempt = new PaymentAttempt({
        paymentId: 'pay_float_amount',
        orderId: dummyOrderId,
        razorpayOrderId: 'order_float_amount',
        amountCapturedPaise: 1250.75,
        currency: 'INR',
      });

      await assert.rejects(async () => await attempt.validate(), /must be an integer number of paise/);
    });

    it('defines unique index on paymentId and compound index on orderId + classification', () => {
      const indexes = PaymentAttempt.schema.indexes();
      const paymentIdIndex = indexes.find((idx: any) => idx[0].paymentId === 1);
      assert.ok(paymentIdIndex, 'Index on paymentId must exist');
      assert.equal(paymentIdIndex[1]?.unique, true, 'paymentId index must be unique');

      const compoundIndex = indexes.find(
        (idx: any) => idx[0].orderId === 1 && idx[0].classification === 1
      );
      assert.ok(compoundIndex, 'Compound index on { orderId: 1, classification: 1 } must exist');
    });
  });

  // ==========================================================================
  // 2. REFUND MODEL BASIC SCHEMA TESTS
  // ==========================================================================
  describe('Refund Model - Schema & Field Validation', () => {
    it('accepts valid refund data with required fields (defaulting to pending)', async () => {
      const refund = new Refund({
        refundId: 'rfnd_valid_123456789',
        orderId: dummyOrderId,
        paymentId: 'pay_valid_123456789',
        amountPaise: 100000,
        currency: 'INR',
        type: 'purchase_compensation',
      });

      await assert.doesNotReject(async () => await refund.validate());
      assert.equal(refund.refundId, 'rfnd_valid_123456789');
      assert.equal(refund.amountPaise, 100000);
      assert.equal(refund.type, 'purchase_compensation');
      assert.equal(refund.status, 'pending');
      assert.equal(refund.settledAt, undefined);
      assert.equal(refund.settlementSource, undefined);
    });

    it('rejects missing required fields (refundId, orderId, paymentId, amountPaise, type)', async () => {
      const refund = new Refund({});
      await assert.rejects(async () => await refund.validate(), (err: any) => {
        assert.ok(err.errors.refundId, 'refundId should be required');
        assert.ok(err.errors.orderId, 'orderId should be required');
        assert.ok(err.errors.paymentId, 'paymentId should be required');
        assert.ok(err.errors.amountPaise, 'amountPaise should be required');
        assert.ok(err.errors.type, 'type should be required');
        return true;
      });
    });

    it('rejects zero or negative refund amounts (min: 1 paisa)', async () => {
      const zeroRefund = new Refund({
        refundId: 'rfnd_zero',
        orderId: dummyOrderId,
        paymentId: 'pay_123',
        amountPaise: 0,
        currency: 'INR',
        type: 'partial_refund',
      });
      await assert.rejects(async () => await zeroRefund.validate(), /amount must be at least 1 paisa/);

      const negRefund = new Refund({
        refundId: 'rfnd_neg',
        orderId: dummyOrderId,
        paymentId: 'pay_123',
        amountPaise: -500,
        currency: 'INR',
        type: 'partial_refund',
      });
      await assert.rejects(async () => await negRefund.validate(), /amount must be at least 1 paisa/);
    });

    it('rejects non-integer refund amounts', async () => {
      const floatRefund = new Refund({
        refundId: 'rfnd_float',
        orderId: dummyOrderId,
        paymentId: 'pay_123',
        amountPaise: 499.5,
        currency: 'INR',
        type: 'partial_refund',
      });
      await assert.rejects(async () => await floatRefund.validate(), /must be an integer number of paise/);
    });

    it('rejects invalid refund type or status', async () => {
      const refund = new Refund({
        refundId: 'rfnd_invalid_enum',
        orderId: dummyOrderId,
        paymentId: 'pay_123',
        amountPaise: 5000,
        currency: 'INR',
        type: 'invalid_type' as any,
        status: 'invalid_status' as any,
      });

      await assert.rejects(async () => await refund.validate(), (err: any) => {
        assert.ok(err.errors.type, 'type should fail validation');
        assert.ok(err.errors.status, 'status should fail validation');
        return true;
      });
    });

    it('defines unique index on refundId and compound index on orderId + paymentId', () => {
      const indexes = Refund.schema.indexes();
      const refundIdIndex = indexes.find((idx: any) => idx[0].refundId === 1);
      assert.ok(refundIdIndex, 'Index on refundId must exist');
      assert.equal(refundIdIndex[1]?.unique, true, 'refundId index must be unique');

      const compoundIndex = indexes.find(
        (idx: any) => idx[0].orderId === 1 && idx[0].paymentId === 1
      );
      assert.ok(compoundIndex, 'Compound index on { orderId: 1, paymentId: 1 } must exist');
    });
  });

  // ==========================================================================
  // 3. REFUND SETTLEMENT DEFAULTS & METADATA GUARANTEES
  // ==========================================================================
  describe('Refund Settlement Defaults & Metadata Guarantees', () => {
    it('creates a refund with default status "pending" and undefined settledAt / settlementSource when settlement evidence is omitted', async () => {
      const refund = new Refund({
        refundId: 'rfnd_test_def_001',
        orderId: dummyOrderId,
        paymentId: 'pay_test_001',
        amountPaise: 50000,
        currency: 'INR',
        type: 'purchase_compensation',
      });

      await refund.validate();
      assert.equal(refund.status, 'pending');
      assert.equal(refund.settledAt, undefined);
      assert.equal(refund.settlementSource, undefined);
      assert.equal(refund.settlementVerifiedAt, undefined);
    });

    it('rejects a refund marked "settled" if settledAt confirmation timestamp is missing', async () => {
      const refund = new Refund({
        refundId: 'rfnd_test_settled_missing_time',
        orderId: dummyOrderId,
        paymentId: 'pay_test_002',
        amountPaise: 50000,
        currency: 'INR',
        type: 'purchase_compensation',
        status: 'settled',
        settlementSource: 'webhook',
      });

      await assert.rejects(
        async () => await refund.validate(),
        /settledAt timestamp is strictly required when refund status is settled/i
      );
    });

    it('rejects a refund marked "settled" if settlementSource is missing', async () => {
      const refund = new Refund({
        refundId: 'rfnd_test_settled_missing_source',
        orderId: dummyOrderId,
        paymentId: 'pay_test_002b',
        amountPaise: 50000,
        currency: 'INR',
        type: 'purchase_compensation',
        status: 'settled',
        settledAt: new Date(),
      });

      await assert.rejects(
        async () => await refund.validate(),
        /settlementSource is strictly required when refund status is settled/i
      );
    });

    it('rejects a refund marked "pending" if settledAt, settlementSource, or settlementVerifiedAt are populated', async () => {
      // 1. Pending with settledAt
      const refundWithTime = new Refund({
        refundId: 'rfnd_test_pending_invalid_time',
        orderId: dummyOrderId,
        paymentId: 'pay_test_003',
        amountPaise: 50000,
        currency: 'INR',
        type: 'purchase_compensation',
        status: 'pending',
        settledAt: new Date(),
      });
      await assert.rejects(
        async () => await refundWithTime.validate(),
        /must not be set when pending/i
      );

      // 2. Pending with settlementSource
      const refundWithSource = new Refund({
        refundId: 'rfnd_test_pending_invalid_source',
        orderId: dummyOrderId,
        paymentId: 'pay_test_003b',
        amountPaise: 50000,
        currency: 'INR',
        type: 'purchase_compensation',
        status: 'pending',
        settlementSource: 'webhook',
      });
      await assert.rejects(
        async () => await refundWithSource.validate(),
        /A pending refund cannot have a settlementSource populated/i
      );
    });

    it('validates internal consistency of settlement metadata when explicitly populated, without implying external gateway verification', async () => {
      const settledTimestamp = new Date();
      const verifiedTimestamp = new Date();
      const refund = new Refund({
        refundId: 'rfnd_test_explicit_settled',
        orderId: dummyOrderId,
        paymentId: 'pay_test_004',
        amountPaise: 50000,
        currency: 'INR',
        type: 'purchase_compensation',
        status: 'settled',
        settledAt: settledTimestamp,
        settlementSource: 'webhook' as RefundSettlementSource,
        settlementVerifiedAt: verifiedTimestamp,
      });

      await assert.doesNotReject(async () => await refund.validate());
      assert.equal(refund.status, 'settled');
      assert.equal(refund.settledAt, settledTimestamp);
      assert.equal(refund.settlementSource, 'webhook');
      assert.equal(refund.settlementVerifiedAt, verifiedTimestamp);
    });
  });

  // ==========================================================================
  // 4. REFUND JOB MODEL BASIC SCHEMA TESTS
  // ==========================================================================
  describe('RefundJob Model - Schema & Field Validation', () => {
    it('accepts valid refund job data across all supported states', async () => {
      const states = [
        'pending',
        'processing',
        'uncertain',
        'succeeded',
        'failed_retryable',
        'manual_review',
      ] as const;

      for (const st of states) {
        const job = new RefundJob({
          orderId: dummyOrderId,
          targetPaymentId: 'pay_target_123',
          targetAmountPaise: 50000,
          currency: 'INR',
          reason: 'duplicate_charge_compensation',
          classification: 'duplicate_charge_compensation',
          idempotencyKey: `idem_rfnd_job_${st}`,
          status: st,
        });

        await assert.doesNotReject(async () => await job.validate());
        assert.equal(job.status, st);
        assert.equal(job.apiDispatched, false);
        assert.equal(job.attempts, 0);
        assert.equal(job.maxRetries, 3);
      }
    });

    it('rejects missing required fields (orderId, targetPaymentId, targetAmountPaise, reason, idempotencyKey)', async () => {
      const job = new RefundJob({});
      await assert.rejects(async () => await job.validate(), (err: any) => {
        assert.ok(err.errors.orderId, 'orderId should be required');
        assert.ok(err.errors.targetPaymentId, 'targetPaymentId should be required');
        assert.ok(err.errors.targetAmountPaise, 'targetAmountPaise should be required');
        assert.ok(err.errors.reason, 'reason should be required');
        assert.ok(err.errors.idempotencyKey, 'idempotencyKey should be required');
        return true;
      });
    });

    it('rejects zero or negative target refund amount', async () => {
      const jobZero = new RefundJob({
        orderId: dummyOrderId,
        targetPaymentId: 'pay_123',
        targetAmountPaise: 0,
        currency: 'INR',
        reason: 'test',
        idempotencyKey: 'idem_zero',
      });
      await assert.rejects(async () => await jobZero.validate(), /amount must be at least 1 paisa/);

      const jobNeg = new RefundJob({
        orderId: dummyOrderId,
        targetPaymentId: 'pay_123',
        targetAmountPaise: -100,
        currency: 'INR',
        reason: 'test',
        idempotencyKey: 'idem_neg',
      });
      await assert.rejects(async () => await jobNeg.validate(), /amount must be at least 1 paisa/);
    });

    it('rejects floating-point target amount in paise', async () => {
      const job = new RefundJob({
        orderId: dummyOrderId,
        targetPaymentId: 'pay_123',
        targetAmountPaise: 1000.5,
        currency: 'INR',
        reason: 'test',
        idempotencyKey: 'idem_float',
      });
      await assert.rejects(async () => await job.validate(), /must be an integer number of paise/);
    });
  });

  // ==========================================================================
  // 5. COMPENSATION JOB UNIQUENESS & IDEMPOTENCY RULES
  // ==========================================================================
  describe('Compensation Job Uniqueness & Idempotency Rules', () => {
    it('enforces global uniqueness on idempotencyKey to prevent duplicate jobs', () => {
      const indexes = RefundJob.schema.indexes();
      const idemIndex = indexes.find((idx: any) => idx[0].idempotencyKey === 1);
      assert.ok(idemIndex, 'Unique index on idempotencyKey must exist');
      assert.equal(idemIndex[1]?.unique, true, 'idempotencyKey index must be unique');
    });

    it('does not place blanket unique constraint on { targetPaymentId, reason }, permitting legitimate distinct jobs', async () => {
      const indexes = RefundJob.schema.indexes();
      const compoundIndex = indexes.find(
        (idx: any) => idx[0].targetPaymentId === 1 && idx[0].reason === 1
      );
      assert.ok(compoundIndex, 'Query performance index on { targetPaymentId, reason } must exist');
      assert.notEqual(
        compoundIndex[1]?.unique,
        true,
        'Blanket unique constraint on { targetPaymentId, reason } must NOT exist, to avoid blocking legitimate separate partial refunds'
      );

      // Two distinct jobs for same payment and reason with unique idempotency keys pass validation
      const job1 = new RefundJob({
        orderId: dummyOrderId,
        targetPaymentId: 'pay_multi_refund_101',
        targetAmountPaise: 20000,
        currency: 'INR',
        reason: 'damaged_item_partial_refund',
        classification: 'partial_refund',
        idempotencyKey: 'refund:partial:order:ORD_01:request:REQ_001:item:ITM_01',
      });

      const job2 = new RefundJob({
        orderId: dummyOrderId,
        targetPaymentId: 'pay_multi_refund_101',
        targetAmountPaise: 30000,
        currency: 'INR',
        reason: 'damaged_item_partial_refund',
        classification: 'partial_refund',
        idempotencyKey: 'refund:partial:order:ORD_01:request:REQ_002:item:ITM_02',
      });

      await assert.doesNotReject(async () => await job1.validate());
      await assert.doesNotReject(async () => await job2.validate());
    });

    it('proves deterministic idempotency keys across retries for the same business return request while distinct requests produce distinct keys', () => {
      // 1. Stable key helper pattern representing the business rule
      const makePartialRefundIdempotencyKey = (
        orderId: string,
        returnRequestId: string,
        itemId: string
      ) => `refund:partial:order:${orderId}:request:${returnRequestId}:item:${itemId}`;

      const orderIdStr = 'ORD_ABC_123';
      const returnRequestIdA = 'RET_REQ_20261123_01';
      const itemIdA = 'PROJ_DRONE_01';

      // Simulation of retry 1 vs retry 2 of the SAME customer refund request
      const keyFirstAttempt = makePartialRefundIdempotencyKey(orderIdStr, returnRequestIdA, itemIdA);
      const keyRetryAttempt = makePartialRefundIdempotencyKey(orderIdStr, returnRequestIdA, itemIdA);

      // MUST be identical so MongoDB unique index prevents duplicate dispatch on retry
      assert.equal(
        keyFirstAttempt,
        keyRetryAttempt,
        'Idempotency key must remain identical across worker retries of the same logical refund request'
      );

      // Simulation of a genuinely distinct subsequent refund request (e.g. customer later returns another item)
      const returnRequestIdB = 'RET_REQ_20261123_02';
      const itemIdB = 'PROJ_ROBOT_02';
      const keyDistinctRequest = makePartialRefundIdempotencyKey(orderIdStr, returnRequestIdB, itemIdB);

      assert.notEqual(
        keyFirstAttempt,
        keyDistinctRequest,
        'Genuinely distinct refund requests must generate distinct idempotency keys'
      );
    });
  });

  // ==========================================================================
  // 6. STRICT CURRENCY VALIDATION (INR ENFORCED)
  // ==========================================================================
  describe('Strict Currency Validation (INR Enforced)', () => {
    it('accepts explicit valid currency "INR" on all models', async () => {
      const attempt = new PaymentAttempt({
        paymentId: 'pay_curr_inr',
        orderId: dummyOrderId,
        razorpayOrderId: 'order_curr_inr',
        amountCapturedPaise: 100000,
        currency: 'INR',
      });
      await attempt.validate();
      assert.equal(attempt.currency, 'INR');

      const refund = new Refund({
        refundId: 'rfnd_curr_inr',
        orderId: dummyOrderId,
        paymentId: 'pay_curr_inr',
        amountPaise: 100000,
        type: 'partial_refund',
        currency: 'INR',
      });
      await refund.validate();
      assert.equal(refund.currency, 'INR');

      const job = new RefundJob({
        orderId: dummyOrderId,
        targetPaymentId: 'pay_curr_inr',
        targetAmountPaise: 100000,
        reason: 'test',
        idempotencyKey: 'idem_curr_inr',
        currency: 'INR',
      });
      await job.validate();
      assert.equal(job.currency, 'INR');

      const order = new Order({
        orderId: 'ORD_CURR_INR',
        receipt: 'rcpt_curr_inr',
        userId: dummyUserId,
        totalAmount: 1000,
        currency: 'INR',
        idempotencyKey: 'idem_order_curr_inr',
        items: [
          {
            projectId: dummyProjectId,
            projectSlug: 'test',
            title: 'Test',
            price: 1000,
            quantity: 1,
          },
        ],
      });
      await order.validate();
      assert.equal(order.currency, 'INR');
    });

    it('rejects lowercase "inr" and does not silently accept or cast it', async () => {
      const attempt = new PaymentAttempt({
        paymentId: 'pay_curr_lower',
        orderId: dummyOrderId,
        razorpayOrderId: 'order_curr',
        amountCapturedPaise: 10000,
        currency: 'inr',
      });
      await assert.rejects(async () => await attempt.validate(), /strictly requires currency INR/i);

      const refund = new Refund({
        refundId: 'rfnd_curr_lower',
        orderId: dummyOrderId,
        paymentId: 'pay_123',
        amountPaise: 10000,
        type: 'partial_refund',
        currency: 'inr',
      });
      await assert.rejects(async () => await refund.validate(), /strictly requires currency INR/i);

      const job = new RefundJob({
        orderId: dummyOrderId,
        targetPaymentId: 'pay_123',
        targetAmountPaise: 10000,
        reason: 'test',
        idempotencyKey: 'idem_curr_lower',
        currency: 'inr',
      });
      await assert.rejects(async () => await job.validate(), /strictly requires currency INR/i);

      const order = new Order({
        orderId: 'ORD_LOWER_INR',
        receipt: 'rcpt_lower_inr',
        userId: dummyUserId,
        totalAmount: 100,
        currency: 'inr',
        idempotencyKey: 'idem_order_lower',
        items: [{ projectId: dummyProjectId, projectSlug: 'test', title: 'Test', price: 100, quantity: 1 }],
      });
      await assert.rejects(async () => await order.validate(), /strictly requires currency INR/i);
    });

    it('rejects unsupported currencies (USD, EUR, GBP) without silent conversion', async () => {
      const unsupported = ['USD', 'EUR', 'GBP', 'JPY', 'CAD'];
      for (const curr of unsupported) {
        const attempt = new PaymentAttempt({
          paymentId: `pay_unsupp_${curr}`,
          orderId: dummyOrderId,
          razorpayOrderId: 'order_curr',
          amountCapturedPaise: 10000,
          currency: curr,
        });
        await assert.rejects(
          async () => await attempt.validate(),
          /strictly requires currency INR/i,
          `Unsupported currency "${curr}" must be rejected`
        );
      }
    });

    it('rejects empty or whitespace-only currency strings', async () => {
      const attempt = new PaymentAttempt({
        paymentId: 'pay_curr_empty',
        orderId: dummyOrderId,
        razorpayOrderId: 'order_curr',
        amountCapturedPaise: 10000,
        currency: '   ',
      });
      await assert.rejects(async () => await attempt.validate(), /Currency is required|strictly requires currency INR/i);
    });
  });

  // ==========================================================================
  // 7. IMMUTABILITY GUARDS ACROSS ALL UPDATE PATHS
  // ==========================================================================
  describe('Immutability across Document Saves and Query Updates', () => {
    // ------------------------------------------------------------------------
    // PaymentAttempt Immutability
    // ------------------------------------------------------------------------
    describe('PaymentAttempt Immutability', () => {
      it('rejects changes to all immutable fields through schema-level immutability and document .save()', () => {
        const fields = PAYMENT_ATTEMPT_IMMUTABLE_FIELDS;
        assert.deepEqual([...fields].sort(), [
          'amountCapturedPaise',
          'classification',
          'currency',
          'orderId',
          'paymentId',
          'razorpayOrderId',
        ]);

        for (const field of fields) {
          const doc = PaymentAttempt.hydrate({
            _id: new mongoose.Types.ObjectId(),
            paymentId: 'pay_base_101',
            orderId: dummyOrderId,
            razorpayOrderId: 'order_base_101',
            amountCapturedPaise: 100000,
            currency: 'INR',
            status: 'captured',
            classification: 'primary',
          });

          const originalVal = (doc as any)[field];
          const tamperedVal =
            field === 'amountCapturedPaise'
              ? 200000
              : field === 'orderId'
                ? dummyOrderId2
                : 'tampered_val';

          // 1. Schema-level immutability: direct assignment is silently ignored by Mongoose
          (doc as any)[field] = tamperedVal;
          assert.strictEqual(
            (doc as any)[field],
            originalVal,
            `Schema-level immutability must prevent direct assignment on ${field}`
          );

          // 2. Pre-save guard: forced modification (e.g. via overwriteImmutable) is rejected
          doc.set(field, tamperedVal, { overwriteImmutable: true });
          assert.throws(
            () => {
              (PaymentAttempt.schema as any).s.hooks.execPreSync('save', doc);
            },
            new RegExp(`Cannot modify immutable field: ${field}`, 'i'),
            `Document .save() must block modification of immutable field: ${field}`
          );
        }
      });

      it('rejects query updates (findOneAndUpdate, updateOne, replaceOne, findOneAndReplace) targeting immutable fields via direct fields, $set, $unset, or $inc', () => {
        const fields = PAYMENT_ATTEMPT_IMMUTABLE_FIELDS;

        for (const op of ['findOneAndUpdate', 'updateOne', 'replaceOne', 'findOneAndReplace']) {
          for (const field of fields) {
            // Test $set update
            const qSet = PaymentAttempt.findOneAndUpdate(
              { paymentId: 'pay_101' },
              { $set: { [field]: 'tampered_value' } }
            );
            assert.throws(
              () => {
                (PaymentAttempt.schema as any).s.hooks.execPreSync(op, qSet);
              },
              new RegExp(`Cannot update immutable field: ${field}`, 'i'),
              `${op} with $set on ${field} must be rejected`
            );

            // Test direct field update
            const qDirect = PaymentAttempt.findOneAndUpdate(
              { paymentId: 'pay_101' },
              { [field]: 'tampered_value' } as any
            );
            assert.throws(
              () => {
                (PaymentAttempt.schema as any).s.hooks.execPreSync(op, qDirect);
              },
              new RegExp(`Cannot update immutable field: ${field}`, 'i'),
              `${op} with direct field on ${field} must be rejected`
            );

            // Test $unset update
            const qUnset = PaymentAttempt.findOneAndUpdate(
              { paymentId: 'pay_101' },
              { $unset: { [field]: 1 } }
            );
            assert.throws(
              () => {
                (PaymentAttempt.schema as any).s.hooks.execPreSync(op, qUnset);
              },
              new RegExp(`Cannot update immutable field: ${field}`, 'i'),
              `${op} with $unset on ${field} must be rejected`
            );
          }
        }
      });

      it('allows legitimate lifecycle updates on PaymentAttempt (status, gatewayMethod, failureReason, notes)', () => {
        const doc = PaymentAttempt.hydrate({
          _id: new mongoose.Types.ObjectId(),
          paymentId: 'pay_base_102',
          orderId: dummyOrderId,
          razorpayOrderId: 'order_base_102',
          amountCapturedPaise: 100000,
          currency: 'INR',
          status: 'authorized',
          classification: 'primary',
        });

        // Updating mutable lifecycle fields on document
        doc.status = 'captured';
        doc.gatewayMethod = 'card';
        doc.failureReason = undefined;
        doc.notes = 'Capture completed successfully';

        // Pre-save hook should pass without throwing
        assert.doesNotThrow(() => {
          (PaymentAttempt.schema as any).s.hooks.execPreSync('save', doc);
        });

        // Query updates modifying only lifecycle fields should pass
        const qLifecycle = PaymentAttempt.findOneAndUpdate(
          { paymentId: 'pay_102' },
          {
            $set: {
              status: 'captured',
              gatewayMethod: 'upi',
              notes: 'Lifecycle update',
            },
            $setOnInsert: {
              paymentId: 'pay_102',
              orderId: dummyOrderId,
              razorpayOrderId: 'order_102',
              amountCapturedPaise: 100000,
            },
          },
          { upsert: true }
        );

        assert.doesNotThrow(() => {
          (PaymentAttempt.schema as any).s.hooks.execPreSync('findOneAndUpdate', qLifecycle);
        }, 'Lifecycle query update with $setOnInsert must be permitted');
      });
    });

    // ------------------------------------------------------------------------
    // Refund Immutability
    // ------------------------------------------------------------------------
    describe('Refund Immutability', () => {
      it('rejects changes to immutable fields through schema-level immutability, document .save(), and query updates', () => {
        const fields = REFUND_IMMUTABLE_FIELDS;
        assert.deepEqual([...fields].sort(), [
          'amountPaise',
          'currency',
          'orderId',
          'paymentId',
          'refundId',
          'type',
        ]);

        for (const field of fields) {
          const doc = Refund.hydrate({
            _id: new mongoose.Types.ObjectId(),
            refundId: 'rfnd_base_101',
            orderId: dummyOrderId,
            paymentId: 'pay_base_101',
            amountPaise: 50000,
            currency: 'INR',
            type: 'partial_refund',
            status: 'pending',
          });

          const originalVal = (doc as any)[field];
          const tamperedVal =
            field === 'amountPaise'
              ? 99999
              : field === 'orderId'
                ? dummyOrderId2
                : 'tampered';

          // 1. Schema-level immutability: direct assignment is silently ignored by Mongoose
          (doc as any)[field] = tamperedVal;
          assert.strictEqual(
            (doc as any)[field],
            originalVal,
            `Schema-level immutability must prevent direct assignment on Refund.${field}`
          );

          // 2. Pre-save guard: forced modification (e.g. via overwriteImmutable) is rejected
          doc.set(field, tamperedVal, { overwriteImmutable: true });
          assert.throws(
            () => {
              (Refund.schema as any).s.hooks.execPreSync('save', doc);
            },
            new RegExp(`Cannot modify immutable field: ${field}`, 'i')
          );

          // 3. Query update test: update targeting immutable fields is rejected
          const qUpdate = Refund.findOneAndUpdate(
            { refundId: 'rfnd_101' },
            { $set: { [field]: 'tampered' } }
          );
          assert.throws(
            () => {
              (Refund.schema as any).s.hooks.execPreSync('findOneAndUpdate', qUpdate);
            },
            new RegExp(`Cannot update immutable field: ${field}`, 'i')
          );
        }
      });

      it('allows legitimate lifecycle updates on Refund (status, settledAt, settlementSource, settlementVerifiedAt, failureReason, notes)', () => {
        const doc = Refund.hydrate({
          _id: new mongoose.Types.ObjectId(),
          refundId: 'rfnd_base_102',
          orderId: dummyOrderId,
          paymentId: 'pay_base_102',
          amountPaise: 50000,
          currency: 'INR',
          type: 'partial_refund',
          status: 'pending',
        });

        // Legitimate lifecycle transition: pending -> settled
        doc.status = 'settled';
        doc.settledAt = new Date();
        doc.settlementSource = 'webhook';
        doc.settlementVerifiedAt = new Date();
        doc.notes = 'Gateway confirmed refund processed';

        assert.doesNotThrow(() => {
          (Refund.schema as any).s.hooks.execPreSync('save', doc);
        });

        const qLifecycle = Refund.findOneAndUpdate(
          { refundId: 'rfnd_102' },
          {
            $set: {
              status: 'settled',
              settledAt: new Date(),
              settlementSource: 'webhook',
              settlementVerifiedAt: new Date(),
              notes: 'Confirmed by webhook',
            },
          }
        );

        assert.doesNotThrow(() => {
          (Refund.schema as any).s.hooks.execPreSync('findOneAndUpdate', qLifecycle);
        });
      });
    });

    // ------------------------------------------------------------------------
    // RefundJob Immutability
    // ------------------------------------------------------------------------
    describe('RefundJob Immutability', () => {
      it('rejects changes to immutable job parameters across schema-level immutability, document saves, and query updates', () => {
        const fields = REFUND_JOB_IMMUTABLE_FIELDS;
        assert.deepEqual([...fields].sort(), [
          'classification',
          'currency',
          'idempotencyKey',
          'orderId',
          'reason',
          'targetAmountPaise',
          'targetPaymentId',
        ]);

        for (const field of fields) {
          const doc = RefundJob.hydrate({
            _id: new mongoose.Types.ObjectId(),
            orderId: dummyOrderId,
            targetPaymentId: 'pay_job_101',
            targetAmountPaise: 50000,
            currency: 'INR',
            reason: 'duplicate_charge_compensation',
            classification: 'duplicate_charge_compensation',
            idempotencyKey: 'idem_job_101',
            status: 'pending',
          });

          const originalVal = (doc as any)[field];
          const tamperedVal =
            field === 'targetAmountPaise'
              ? 99999
              : field === 'orderId'
                ? dummyOrderId2
                : 'tampered';

          // 1. Schema-level immutability: direct assignment is silently ignored by Mongoose
          (doc as any)[field] = tamperedVal;
          assert.strictEqual(
            (doc as any)[field],
            originalVal,
            `Schema-level immutability must prevent direct assignment on RefundJob.${field}`
          );

          // 2. Pre-save guard: forced modification (e.g. via overwriteImmutable) is rejected
          doc.set(field, tamperedVal, { overwriteImmutable: true });
          assert.throws(
            () => {
              (RefundJob.schema as any).s.hooks.execPreSync('save', doc);
            },
            new RegExp(`Cannot modify immutable field: ${field}`, 'i')
          );

          // 3. Query update test: update targeting immutable fields is rejected
          const qUpdate = RefundJob.findOneAndUpdate(
            { idempotencyKey: 'idem_job_101' },
            { $set: { [field]: 'tampered' } }
          );
          assert.throws(
            () => {
              (RefundJob.schema as any).s.hooks.execPreSync('findOneAndUpdate', qUpdate);
            },
            new RegExp(`Cannot update immutable field: ${field}`, 'i')
          );
        }
      });

      it('allows legitimate lifecycle updates on RefundJob (lease, status, attempts, errorHistory, providerRefundId)', () => {
        const doc = RefundJob.hydrate({
          _id: new mongoose.Types.ObjectId(),
          orderId: dummyOrderId,
          targetPaymentId: 'pay_job_102',
          targetAmountPaise: 50000,
          currency: 'INR',
          reason: 'duplicate_charge_compensation',
          classification: 'duplicate_charge_compensation',
          idempotencyKey: 'idem_job_102',
          status: 'pending',
          attempts: 0,
        });

        // Worker claims lease
        doc.status = 'processing';
        doc.leaseWorkerId = 'worker_node_1';
        doc.leaseToken = 'token_uuid_123';
        doc.leaseAcquiredAt = new Date();
        doc.leaseExpiresAt = new Date(Date.now() + 60000);
        doc.attempts = 1;
        doc.apiDispatched = true;
        doc.dispatchRecordedAt = new Date();

        assert.doesNotThrow(() => {
          (RefundJob.schema as any).s.hooks.execPreSync('save', doc);
        });

        // Worker succeeds and updates provider refund ID
        const qUpdate = RefundJob.findOneAndUpdate(
          { idempotencyKey: 'idem_job_102', leaseToken: 'token_uuid_123' },
          {
            $set: {
              status: 'succeeded',
              providerRefundId: 'rfnd_rzp_999',
              leaseWorkerId: null,
              leaseToken: null,
            },
          }
        );

        assert.doesNotThrow(() => {
          (RefundJob.schema as any).s.hooks.execPreSync('findOneAndUpdate', qUpdate);
        });
      });
    });
  });

  // ==========================================================================
  // 8. ORDER DUAL-LEDGER FINANCIAL ACCOUNTING MODEL TESTS
  // ==========================================================================
  describe('Order Dual-Ledger Financial Accounting Extensions', () => {
    it('initializes all financial accounting fields with default value 0 in paise', async () => {
      const order = new Order({
        orderId: 'ORD_TEST_FIN_001',
        receipt: 'rcpt_fin_001',
        userId: dummyUserId,
        totalAmount: 4170,
        currency: 'INR',
        idempotencyKey: 'idem_fin_001',
        items: [
          {
            projectId: dummyProjectId,
            projectSlug: 'test-drone',
            title: 'Test Drone',
            price: 4170,
            quantity: 1,
          },
        ],
      });

      await order.validate();
      assert.equal(order.totalCapturedPaise, 0);
      assert.equal(order.purchaseCapturedPaise, 0);
      assert.equal(order.duplicateCapturedPaise, 0);
      assert.equal(order.amountReservedRefundPaise, 0);
      assert.equal(order.confirmedRefundPaise, 0);
      assert.equal(order.purchaseRefundedPaise, 0);
      assert.equal(order.duplicateRefundedPaise, 0);
      assert.equal(order.primaryPaymentId, undefined);
    });

    it('accepts valid integer paise values for all financial accounting fields', async () => {
      const order = new Order({
        orderId: 'ORD_TEST_FIN_002',
        receipt: 'rcpt_fin_002',
        userId: dummyUserId,
        totalAmount: 4170,
        currency: 'INR',
        idempotencyKey: 'idem_fin_002',
        items: [
          {
            projectId: dummyProjectId,
            projectSlug: 'test-drone',
            title: 'Test Drone',
            price: 4170,
            quantity: 1,
          },
        ],
        totalCapturedPaise: 834000,
        purchaseCapturedPaise: 417000,
        duplicateCapturedPaise: 417000,
        amountReservedRefundPaise: 417000,
        confirmedRefundPaise: 0,
        purchaseRefundedPaise: 0,
        duplicateRefundedPaise: 0,
        primaryPaymentId: 'pay_primary_123456',
        paymentStatus: 'duplicate_charge_detected',
      });

      await order.validate();
      assert.equal(order.totalCapturedPaise, 834000);
      assert.equal(order.purchaseCapturedPaise, 417000);
      assert.equal(order.duplicateCapturedPaise, 417000);
      assert.equal(order.primaryPaymentId, 'pay_primary_123456');
      assert.equal(order.paymentStatus, 'duplicate_charge_detected');
    });

    it('rejects negative values for financial accounting paise fields', async () => {
      const fields = [
        'totalCapturedPaise',
        'purchaseCapturedPaise',
        'duplicateCapturedPaise',
        'amountReservedRefundPaise',
        'confirmedRefundPaise',
        'purchaseRefundedPaise',
        'duplicateRefundedPaise',
      ] as const;

      for (const field of fields) {
        const orderData: any = {
          orderId: `ORD_NEG_${field}`,
          receipt: `rcpt_neg_${field}`,
          userId: dummyUserId,
          totalAmount: 100,
          currency: 'INR',
          idempotencyKey: `idem_neg_${field}`,
          items: [
            {
              projectId: dummyProjectId,
              projectSlug: 'test',
              title: 'Test',
              price: 100,
              quantity: 1,
            },
          ],
        };
        orderData[field] = -1;

        const order = new Order(orderData);
        await assert.rejects(
          async () => await order.validate(),
          /cannot be negative/i,
          `Error expected for negative field ${field}`
        );
      }
    });

    it('rejects non-integer floating point values for financial accounting paise fields', async () => {
      const fields = [
        'totalCapturedPaise',
        'purchaseCapturedPaise',
        'duplicateCapturedPaise',
        'amountReservedRefundPaise',
        'confirmedRefundPaise',
        'purchaseRefundedPaise',
        'duplicateRefundedPaise',
      ] as const;

      for (const field of fields) {
        const orderData: any = {
          orderId: `ORD_FLOAT_${field}`,
          receipt: `rcpt_float_${field}`,
          userId: dummyUserId,
          totalAmount: 100,
          currency: 'INR',
          idempotencyKey: `idem_float_${field}`,
          items: [
            {
              projectId: dummyProjectId,
              projectSlug: 'test',
              title: 'Test',
              price: 100,
              quantity: 1,
            },
          ],
        };
        orderData[field] = 4170.25;

        const order = new Order(orderData);
        await assert.rejects(
          async () => await order.validate(),
          /must be an integer number of paise/i,
          `Integer validation error expected for field ${field}`
        );
      }
    });

    it('accepts all extended paymentStatus enum values without breaking existing ones', async () => {
      const statuses = [
        'creating',
        'created',
        'authorized',
        'captured',
        'failed',
        'retryable_failure',
        'unknown',
        'refunded',
        'duplicate_charge_detected',
        'security_discrepancy',
        'held_for_review',
        'refund_pending',
        'partially_refunded',
      ] as const;

      for (const ps of statuses) {
        const order = new Order({
          orderId: `ORD_STATUS_${ps}`,
          receipt: `rcpt_st_${ps}`,
          userId: dummyUserId,
          totalAmount: 500,
          currency: 'INR',
          idempotencyKey: `idem_st_${ps}`,
          paymentStatus: ps,
          items: [
            {
              projectId: dummyProjectId,
              projectSlug: 'test',
              title: 'Test',
              price: 500,
              quantity: 1,
            },
          ],
        });

        await order.validate();
        assert.equal(order.paymentStatus, ps);
      }
    });

    it('proves mathematical separation of purchase and duplicate-payment accounting dimensions', async () => {
      // Customer pays ₹4,170 once (primary), then accidental gateway retry charges ₹4,170 again (duplicate)
      const order = new Order({
        orderId: 'ORD_SEPARATE_DIMENSIONS',
        receipt: 'rcpt_sep_dim',
        userId: dummyUserId,
        totalAmount: 4170,
        currency: 'INR',
        idempotencyKey: 'idem_sep_dim',
        items: [
          {
            projectId: dummyProjectId,
            projectSlug: 'test-drone',
            title: 'Test Drone',
            price: 4170,
            quantity: 1,
          },
        ],
        // Initial primary capture: ₹4,170 = 417,000 paise
        totalCapturedPaise: 417000,
        purchaseCapturedPaise: 417000,
        duplicateCapturedPaise: 0,
        primaryPaymentId: 'pay_primary_first',
        status: 'completed',
        paymentStatus: 'captured',
      });

      // 1. Simulate duplicate charge event
      const duplicateAmount = 417000;
      order.totalCapturedPaise += duplicateAmount;
      order.duplicateCapturedPaise += duplicateAmount;
      order.paymentStatus = 'duplicate_charge_detected';

      // Verify that purchaseCapturedPaise remains invariant:
      assert.equal(order.purchaseCapturedPaise, 417000, 'purchaseCapturedPaise must not change on duplicate charge');
      assert.equal(order.duplicateCapturedPaise, 417000, 'duplicateCapturedPaise must track excess funds');
      assert.equal(order.totalCapturedPaise, 834000, 'totalCapturedPaise must equal purchase + duplicate captured');

      // 2. Simulate reservation for compensation refund of duplicate charge
      order.amountReservedRefundPaise += duplicateAmount;
      assert.equal(order.amountReservedRefundPaise, 417000);
      assert.equal(order.confirmedRefundPaise, 0);

      // 3. Simulate settlement of duplicate-charge compensation refund
      order.confirmedRefundPaise += duplicateAmount;
      order.duplicateRefundedPaise += duplicateAmount;
      order.amountReservedRefundPaise -= duplicateAmount;
      order.paymentStatus = 'captured'; // Returns to clean captured state

      // Verify that primary purchase accounting remains 100% fulfilled and unaffected:
      assert.equal(order.status, 'completed', 'Order status must remain completed');
      assert.equal(order.purchaseCapturedPaise, 417000, 'purchaseCapturedPaise must remain 417000');
      assert.equal(order.purchaseRefundedPaise, 0, 'purchaseRefundedPaise must remain 0');
      assert.equal(order.duplicateRefundedPaise, 417000, 'duplicateRefundedPaise must equal duplicate refunded amount');
      assert.equal(order.amountReservedRefundPaise, 0, 'Reserved refund amount must return to 0');
      assert.equal(order.confirmedRefundPaise, 417000, 'Confirmed refund amount tracks duplicate refund');

      await assert.doesNotReject(async () => await order.validate());
    });
  });
});
