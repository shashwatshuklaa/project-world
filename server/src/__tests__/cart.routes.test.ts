import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import mongoose from 'mongoose';
import app from '../app.js';
import { Cart } from '../models/Cart.js';
import { Project } from '../models/Project.js';
import { generateToken, AUTH_COOKIE_NAME } from '../utils/token.js';
import { isConcurrencyConflict } from '../controllers/cart.controller.js';

// User identities
const user1 = { id: '6740000000000000000000u1', email: 'user1@example.com', role: 'user' as const };
const user2 = { id: '6740000000000000000000u2', email: 'user2@example.com', role: 'user' as const };
const tokenUser1 = generateToken(user1);
const tokenUser2 = generateToken(user2);

// Mock catalog project data
const mockDroneProject = {
  _id: new mongoose.Types.ObjectId('674000000000000000000001'),
  slug: 'eng-Drone-001',
  title: 'Racing Drone Construction Kit',
  category: 'Engineering',
  subcategory: 'Drone',
  price: 4170,
  image: '/projects/drone1.png',
  difficulty: 'Intermediate',
};

const mockRcProject = {
  _id: new mongoose.Types.ObjectId('674000000000000000000002'),
  slug: 'eng-rc-001',
  title: 'Off-Road RC Crawler',
  category: 'Engineering',
  subcategory: 'RC Devices',
  price: 3500,
  image: '/projects/rc1.png',
  difficulty: 'Beginner',
};

// Backup references for restoration
const originalCartFindOne = Cart.findOne;
const originalCartFindOneAndUpdate = Cart.findOneAndUpdate;
const originalCartPrototypeSave = Cart.prototype.save;
const originalProjectFind = Project.find;
const originalProjectFindOne = Project.findOne;

describe('Shopping Cart REST API Integration', () => {
  beforeEach(() => {
    // Default safe mocks
    Cart.prototype.save = async function () {
      return this;
    };
    (Cart as any).findOneAndUpdate = async (filter: any) => {
      return new Cart({ user: filter.user, items: [] });
    };
  });

  afterEach(() => {
    Cart.findOne = originalCartFindOne;
    Cart.findOneAndUpdate = originalCartFindOneAndUpdate;
    Cart.prototype.save = originalCartPrototypeSave;
    Project.find = originalProjectFind;
    Project.findOne = originalProjectFindOne;
  });

  // ==========================================
  // 1. Authentication & Ownership Protection
  // ==========================================
  describe('Authentication & Access Control', () => {
    it('1. rejects unauthenticated requests across all cart endpoints with 401', async () => {
      const getRes = await request(app).get('/api/cart');
      assert.equal(getRes.status, 401);

      const postRes = await request(app).post('/api/cart/items').send({ projectId: 'eng-Drone-001' });
      assert.equal(postRes.status, 401);

      const patchRes = await request(app).patch('/api/cart/items/674000000000000000000011').send({ quantity: 2 });
      assert.equal(patchRes.status, 401);

      const deleteItemRes = await request(app).delete('/api/cart/items/674000000000000000000011');
      assert.equal(deleteItemRes.status, 401);

      const clearRes = await request(app).delete('/api/cart');
      assert.equal(clearRes.status, 401);
    });

    it('2. an authenticated user receives their own cart', async () => {
      let capturedUserFilter: any = null;
      (Cart as any).findOne = (filter: any) => {
        capturedUserFilter = filter;
        return Promise.resolve(null);
      };

      const res = await request(app)
        .get('/api/cart')
        .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`);

      assert.equal(res.status, 200);
      assert.equal(capturedUserFilter?.user, user1.id);
    });

    it('18. a user cannot access or modify another user cart (ownership isolation)', async () => {
      let userLookups: string[] = [];
      (Cart as any).findOne = (filter: any) => {
        userLookups.push(filter.user);
        return Promise.resolve(null);
      };

      await request(app)
        .get('/api/cart')
        .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`);

      await request(app)
        .get('/api/cart')
        .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser2}`);

      assert.deepEqual(userLookups, [user1.id, user2.id]);
    });
  });

  // ==========================================
  // 2. Reading Cart & Empty Responses
  // ==========================================
  describe('GET /api/cart', () => {
    it('3. returns standardized empty cart when user has no active cart', async () => {
      (Cart as any).findOne = () => Promise.resolve(null);

      const res = await request(app)
        .get('/api/cart')
        .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`);

      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.deepEqual(res.body.data.cart, {
        items: [],
        subtotal: 0,
        total: 0,
        itemCount: 0,
      });
    });

    it('20. cart totals use canonical MongoDB project prices, never client data', async () => {
      const mockCartDoc: any = {
        _id: new mongoose.Types.ObjectId('6740000000000000000000c1'),
        user: user1.id,
        items: [
          {
            _id: new mongoose.Types.ObjectId('674000000000000000000011'),
            project: mockDroneProject._id,
            quantity: 2,
            customization: 'Custom paint',
          },
        ],
        save: async () => mockCartDoc,
      };

      (Cart as any).findOne = () => Promise.resolve(mockCartDoc);
      (Project as any).find = () => ({
        lean: () => Promise.resolve([mockDroneProject]),
      });

      const res = await request(app)
        .get('/api/cart')
        .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`);

      assert.equal(res.status, 200);
      const cart = res.body.data.cart;
      assert.equal(cart.items.length, 1);
      assert.equal(cart.items[0].unitPrice, 4170);
      assert.equal(cart.items[0].itemTotal, 8340);
      assert.equal(cart.subtotal, 8340);
      assert.equal(cart.total, 8340);
      assert.equal(cart.itemCount, 2);
    });

    it('21. missing/deleted project references are safely pruned without crashing', async () => {
      let saved = false;
      const mockCartDoc: any = {
        _id: new mongoose.Types.ObjectId('6740000000000000000000c1'),
        user: user1.id,
        items: [
          {
            _id: new mongoose.Types.ObjectId('674000000000000000000011'),
            project: new mongoose.Types.ObjectId('674000000000000000000099'), // Non-existent in DB
            quantity: 1,
          },
        ],
        save: async () => {
          saved = true;
          return mockCartDoc;
        },
      };

      (Cart as any).findOne = () => Promise.resolve(mockCartDoc);
      (Project as any).find = () => ({
        lean: () => Promise.resolve([]), // Project was deleted
      });

      const res = await request(app)
        .get('/api/cart')
        .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`);

      assert.equal(res.status, 200);
      assert.equal(res.body.data.cart.items.length, 0);
      assert.equal(res.body.data.cart.total, 0);
      assert.equal(saved, true);
    });
  });

  // ==========================================
  // 3. Adding Items (POST /api/cart/items)
  // ==========================================
  describe('POST /api/cart/items', () => {
    it('4. adding a valid project succeeds and populates cart details', async () => {
      let savedCart: any = null;
      (Project as any).findOne = () => Promise.resolve(mockDroneProject);
      (Project as any).find = () => ({
        lean: () => Promise.resolve([mockDroneProject]),
      });

      (Cart as any).findOne = () => Promise.resolve(null);
      Cart.prototype.save = async function () {
        savedCart = this;
        return this;
      };

      const res = await request(app)
        .post('/api/cart/items')
        .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
        .send({
          projectId: 'eng-Drone-001',
          quantity: 1,
          customization: 'Initial note',
        });

      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.cart.itemCount, 1);
      assert.equal(res.body.data.cart.items[0].project.title, mockDroneProject.title);
      assert.equal(res.body.data.cart.items[0].unitPrice, 4170);
      assert.equal(savedCart.items.length, 1);
    });

    it('5. adding an existing project increments quantity and 6. does not create duplicate entries', async () => {
      const mockCartDoc: any = {
        _id: new mongoose.Types.ObjectId('6740000000000000000000c1'),
        user: user1.id,
        items: [
          {
            _id: new mongoose.Types.ObjectId('674000000000000000000011'),
            project: mockDroneProject._id,
            quantity: 2,
            customization: 'Existing note',
          },
        ],
        save: async () => mockCartDoc,
      };

      (Project as any).findOne = () => Promise.resolve(mockDroneProject);
      (Project as any).find = () => ({
        lean: () => Promise.resolve([mockDroneProject]),
      });
      (Cart as any).findOne = () => Promise.resolve(mockCartDoc);

      const res = await request(app)
        .post('/api/cart/items')
        .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
        .send({
          projectId: 'eng-Drone-001',
          quantity: 3,
        });

      assert.equal(res.status, 200);
      assert.equal(mockCartDoc.items.length, 1); // No duplicate entries
      assert.equal(mockCartDoc.items[0].quantity, 5); // 2 + 3 = 5
      assert.equal(res.body.data.cart.itemCount, 5);
      assert.equal(res.body.data.cart.total, 5 * 4170);
    });

    it('7. quantity above 10 in payload is rejected with 400', async () => {
      const res = await request(app)
        .post('/api/cart/items')
        .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
        .send({
          projectId: 'eng-Drone-001',
          quantity: 11,
        });

      assert.equal(res.status, 400);
      assert.equal(res.body.success, false);
      assert.ok(res.body.errors.some((e: any) => e.field === 'quantity'));
    });

    it('8. incrementing an item already at quantity 10 or exceeding 10 is rejected with 400', async () => {
      const mockCartDoc: any = {
        _id: new mongoose.Types.ObjectId('6740000000000000000000c1'),
        user: user1.id,
        items: [
          {
            _id: new mongoose.Types.ObjectId('674000000000000000000011'),
            project: mockDroneProject._id,
            quantity: 10,
          },
        ],
        save: async () => mockCartDoc,
      };

      (Project as any).findOne = () => Promise.resolve(mockDroneProject);
      (Cart as any).findOne = () => Promise.resolve(mockCartDoc);

      const resAtMax = await request(app)
        .post('/api/cart/items')
        .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
        .send({
          projectId: 'eng-Drone-001',
          quantity: 1,
        });

      assert.equal(resAtMax.status, 400);
      assert.match(resAtMax.body.message, /maximum quantity limit/i);
    });

    it('9. invalid project IDs with malicious characters are rejected with 400', async () => {
      const res = await request(app)
        .post('/api/cart/items')
        .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
        .send({
          projectId: 'invalid$project{id}',
        });

      assert.equal(res.status, 400);
      assert.ok(res.body.errors.some((e: any) => e.field === 'projectId'));
    });

    it('10. nonexistent projects return 404', async () => {
      (Project as any).findOne = () => Promise.resolve(null);

      const res = await request(app)
        .post('/api/cart/items')
        .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
        .send({
          projectId: 'non-existent-slug-12345',
        });

      assert.equal(res.status, 404);
      assert.equal(res.body.success, false);
      assert.match(res.body.message, /Project not found/);
    });

    it('19. client-supplied price and total fields are rejected with 400 via strict schema', async () => {
      const resPrice = await request(app)
        .post('/api/cart/items')
        .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
        .send({
          projectId: 'eng-Drone-001',
          price: 1.0, // Attempted tampering
        });

      assert.equal(resPrice.status, 400);
      assert.equal(resPrice.body.success, false);

      const resTotal = await request(app)
        .post('/api/cart/items')
        .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
        .send({
          projectId: 'eng-Drone-001',
          total: 5.0, // Attempted tampering
        });

      assert.equal(resTotal.status, 400);
      assert.equal(resTotal.body.success, false);
    });
  });

  // ==========================================
  // 4. Updating Items (PATCH /api/cart/items/:itemId)
  // ==========================================
  describe('PATCH /api/cart/items/:itemId', () => {
    it('11. updating quantity works successfully', async () => {
      const itemId = '674000000000000000000011';
      const mockCartDoc: any = {
        _id: new mongoose.Types.ObjectId('6740000000000000000000c1'),
        user: user1.id,
        items: [
          {
            _id: new mongoose.Types.ObjectId(itemId),
            project: mockDroneProject._id,
            quantity: 1,
            customization: 'Old note',
          },
        ],
        save: async () => mockCartDoc,
      };

      (Cart as any).findOne = () => Promise.resolve(mockCartDoc);
      (Project as any).find = () => ({
        lean: () => Promise.resolve([mockDroneProject]),
      });

      const res = await request(app)
        .patch(`/api/cart/items/${itemId}`)
        .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
        .send({
          quantity: 4,
        });

      assert.equal(res.status, 200);
      assert.equal(mockCartDoc.items[0].quantity, 4);
      assert.equal(res.body.data.cart.itemCount, 4);
      assert.equal(res.body.data.cart.total, 4 * 4170);
    });

    it('12. updating customization works successfully', async () => {
      const itemId = '674000000000000000000011';
      const mockCartDoc: any = {
        _id: new mongoose.Types.ObjectId(itemId),
        user: user1.id,
        items: [
          {
            _id: new mongoose.Types.ObjectId(itemId),
            project: mockDroneProject._id,
            quantity: 1,
            customization: 'Old note',
          },
        ],
        save: async () => mockCartDoc,
      };

      (Cart as any).findOne = () => Promise.resolve(mockCartDoc);
      (Project as any).find = () => ({
        lean: () => Promise.resolve([mockDroneProject]),
      });

      const res = await request(app)
        .patch(`/api/cart/items/${itemId}`)
        .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
        .send({
          customization: 'Deliver with pre-soldered ESCs',
        });

      assert.equal(res.status, 200);
      assert.equal(mockCartDoc.items[0].customization, 'Deliver with pre-soldered ESCs');
      assert.equal(res.body.data.cart.items[0].customization, 'Deliver with pre-soldered ESCs');
    });

    it('13. empty update payload is rejected with 400', async () => {
      const res = await request(app)
        .patch('/api/cart/items/674000000000000000000011')
        .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
        .send({});

      assert.equal(res.status, 400);
      assert.equal(res.body.success, false);
      assert.ok(res.body.errors.some((e: any) => /at least one/i.test(e.message)));
    });

    it('14. invalid customization length (> 500 characters) is rejected with 400', async () => {
      const res = await request(app)
        .patch('/api/cart/items/674000000000000000000011')
        .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
        .send({
          customization: 'A'.repeat(501),
        });

      assert.equal(res.status, 400);
      assert.equal(res.body.success, false);
      assert.ok(res.body.errors.some((e: any) => e.field === 'customization'));
    });
  });

  // ==========================================
  // 5. Removing Items (DELETE /api/cart/items/:itemId)
  // ==========================================
  describe('DELETE /api/cart/items/:itemId', () => {
    it('15. removing an existing item works and recalculates totals', async () => {
      const item1Id = '674000000000000000000011';
      const item2Id = '674000000000000000000022';
      const mockCartDoc: any = {
        _id: new mongoose.Types.ObjectId('6740000000000000000000c1'),
        user: user1.id,
        items: [
          {
            _id: new mongoose.Types.ObjectId(item1Id),
            project: mockDroneProject._id,
            quantity: 1,
          },
          {
            _id: new mongoose.Types.ObjectId(item2Id),
            project: mockRcProject._id,
            quantity: 2,
          },
        ],
        save: async () => mockCartDoc,
      };

      (Cart as any).findOne = () => Promise.resolve(mockCartDoc);
      (Project as any).find = () => ({
        lean: () => Promise.resolve([mockRcProject]),
      });

      const res = await request(app)
        .delete(`/api/cart/items/${item1Id}`)
        .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`);

      assert.equal(res.status, 200);
      assert.equal(mockCartDoc.items.length, 1);
      assert.equal(mockCartDoc.items[0]._id.toString(), item2Id);
      assert.equal(res.body.data.cart.items.length, 1);
      assert.equal(res.body.data.cart.total, 2 * 3500);
    });

    it('16. removing a nonexistent item returns 404', async () => {
      const mockCartDoc: any = {
        _id: new mongoose.Types.ObjectId('6740000000000000000000c1'),
        user: user1.id,
        items: [],
        save: async () => mockCartDoc,
      };

      (Cart as any).findOne = () => Promise.resolve(mockCartDoc);

      const res = await request(app)
        .delete('/api/cart/items/674000000000000000000099')
        .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`);

      assert.equal(res.status, 404);
      assert.equal(res.body.success, false);
      assert.match(res.body.message, /not found in cart/i);
    });
  });

  // ==========================================
  // 6. Clearing Cart (DELETE /api/cart)
  // ==========================================
  describe('DELETE /api/cart', () => {
    it('17. clearing a cart empties items and resets totals to zero', async () => {
      let saved = false;
      const mockCartDoc: any = {
        _id: new mongoose.Types.ObjectId('6740000000000000000000c1'),
        user: user1.id,
        items: [
          {
            _id: new mongoose.Types.ObjectId('674000000000000000000011'),
            project: mockDroneProject._id,
            quantity: 3,
          },
        ],
        save: async () => {
          saved = true;
          return mockCartDoc;
        },
      };

      (Cart as any).findOne = () => Promise.resolve(mockCartDoc);

      const res = await request(app)
        .delete('/api/cart')
        .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`);

      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.deepEqual(res.body.data.cart, {
        items: [],
        subtotal: 0,
        total: 0,
        itemCount: 0,
      });
      assert.equal(saved, true);
      assert.equal(mockCartDoc.items.length, 0);
    });
  });

  // ==========================================
  // 7. Database Error Handling
  // ==========================================
  describe('Database Error Handling', () => {
    it('22. handles database query failures gracefully with HTTP 500 without leaking stack traces', async () => {
      (Cart as any).findOne = () => Promise.reject(new Error('MongoNetworkTimeoutException: connection dropped'));

      const res = await request(app)
        .get('/api/cart')
        .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`);

      assert.equal(res.status, 500);
      assert.equal(res.body.success, false);
      assert.equal(res.body.message, 'Failed to retrieve shopping cart. Please try again later.');
      assert.equal(res.body.stack, undefined);
    });
  });

  // ==========================================
  // 8. Overlapping & Sequential Mutations
  // ==========================================
  describe('Overlapping & Sequential Mutations', () => {
    it('23. sequential additions of distinct projects accumulate correctly in the cart', async () => {
      // Shared in-memory cart document reflecting persistent state
      const mockCartDoc: any = {
        _id: new mongoose.Types.ObjectId('6740000000000000000000c1'),
        user: user1.id,
        items: [] as any[],
        save: async function () {
          return this;
        },
      };

      (Cart as any).findOne = () => Promise.resolve(mockCartDoc);
      (Project as any).findOne = (query: any) => {
        if (query.$or?.[0]?.slug === 'eng-Drone-001' || query.slug === 'eng-Drone-001') {
          return Promise.resolve(mockDroneProject);
        }
        if (query.$or?.[0]?.slug === 'eng-rc-001' || query.slug === 'eng-rc-001') {
          return Promise.resolve(mockRcProject);
        }
        return Promise.resolve(null);
      };
      (Project as any).find = () => ({
        lean: () => Promise.resolve([mockDroneProject, mockRcProject]),
      });

      // 1. Add project A (Drone, price: 4170)
      const resA = await request(app)
        .post('/api/cart/items')
        .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
        .send({ projectId: 'eng-Drone-001', quantity: 1 });

      assert.equal(resA.status, 200);
      assert.equal(resA.body.data.cart.items.length, 1);
      assert.equal(resA.body.data.cart.total, 4170);

      // 2. Add project B (RC, price: 3500)
      const resB = await request(app)
        .post('/api/cart/items')
        .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
        .send({ projectId: 'eng-rc-001', quantity: 2 });

      assert.equal(resB.status, 200);
      assert.equal(resB.body.data.cart.items.length, 2);
      assert.equal(resB.body.data.cart.itemCount, 3); // 1 Drone + 2 RC
      assert.equal(resB.body.data.cart.total, 4170 + 2 * 3500); // 11170
    });
  });

  // ==========================================
  // 9. Optimistic Concurrency Control (OCC) & Race Conditions
  // ==========================================
  describe('Optimistic Concurrency Control (OCC) & Race Conditions', () => {
    it('24. two simultaneous first-time cart creations handle race condition safely without leaking duplicate key errors', async () => {
      let createdDoc: any = null;
      let findOneAndUpdateCalls = 0;

      (Project as any).findOne = (query: any) => {
        if (query.$or?.[0]?.slug === 'eng-Drone-001' || query.slug === 'eng-Drone-001') {
          return Promise.resolve(mockDroneProject);
        }
        if (query.$or?.[0]?.slug === 'eng-rc-001' || query.slug === 'eng-rc-001') {
          return Promise.resolve(mockRcProject);
        }
        return Promise.resolve(null);
      };
      (Project as any).find = () => ({
        lean: () => Promise.resolve([mockDroneProject, mockRcProject]),
      });

      (Cart as any).findOne = async () => createdDoc;

      (Cart as any).findOneAndUpdate = async (filter: any) => {
        findOneAndUpdateCalls++;
        if (findOneAndUpdateCalls === 1) {
          createdDoc = {
            _id: new mongoose.Types.ObjectId('6740000000000000000000c1'),
            user: filter.user,
            items: [] as any[],
            save: async function () {
              return this;
            },
          };
          return createdDoc;
        } else {
          // Simultaneous request hits duplicate key collision on user_1
          const dupErr: any = new Error('E11000 duplicate key error collection: test.carts index: user_1 dup key');
          dupErr.code = 11000;
          dupErr.name = 'MongoServerError';
          throw dupErr;
        }
      };

      const [res1, res2] = await Promise.all([
        request(app)
          .post('/api/cart/items')
          .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
          .send({ projectId: 'eng-Drone-001', quantity: 1 }),
        request(app)
          .post('/api/cart/items')
          .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
          .send({ projectId: 'eng-rc-001', quantity: 2 }),
      ]);

      assert.equal(res1.status, 200);
      assert.equal(res2.status, 200);
      assert.equal(res1.body.success, true);
      assert.equal(res2.body.success, true);
      assert.equal(createdDoc.items.length, 2);
    });

    it('25. a version conflict during save retries with fresh cart and succeeds on second attempt', async () => {
      let saveAttempts = 0;
      let dbCartItems: any[] = [];

      (Cart as any).findOne = async () => ({
        _id: new mongoose.Types.ObjectId('6740000000000000000000c1'),
        user: user1.id,
        items: [...dbCartItems],
        save: async function () {
          saveAttempts++;
          if (saveAttempts === 1) {
            const versionErr: any = new Error('No matching document found for id version 0');
            versionErr.name = 'VersionError';
            throw versionErr;
          }
          dbCartItems = this.items;
          return this;
        },
      });

      (Project as any).findOne = () => Promise.resolve(mockDroneProject);
      (Project as any).find = () => ({
        lean: () => Promise.resolve([mockDroneProject]),
      });

      const res = await request(app)
        .post('/api/cart/items')
        .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
        .send({ projectId: 'eng-Drone-001', quantity: 2 });

      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.equal(saveAttempts, 2, 'Must have attempted save twice (1 conflict + 1 retry)');
      assert.equal(res.body.data.cart.items.length, 1);
      assert.equal(res.body.data.cart.itemCount, 2);
    });

    it('26. multiple consecutive version conflicts retry up to limit and succeed on third attempt', async () => {
      let saveAttempts = 0;
      let dbCartItems: any[] = [];

      (Cart as any).findOne = async () => ({
        _id: new mongoose.Types.ObjectId('6740000000000000000000c1'),
        user: user1.id,
        items: [...dbCartItems],
        save: async function () {
          saveAttempts++;
          if (saveAttempts <= 2) {
            const versionErr: any = new Error('No matching document found for id version 0');
            versionErr.name = 'VersionError';
            throw versionErr;
          }
          dbCartItems = this.items;
          return this;
        },
      });

      (Project as any).findOne = () => Promise.resolve(mockDroneProject);
      (Project as any).find = () => ({
        lean: () => Promise.resolve([mockDroneProject]),
      });

      const res = await request(app)
        .post('/api/cart/items')
        .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
        .send({ projectId: 'eng-Drone-001', quantity: 1 });

      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.equal(saveAttempts, 3, 'Must have attempted save exactly 3 times (2 conflicts + 1 successful)');
      assert.equal(res.body.data.cart.itemCount, 1);
    });

    it('27. retry exhaustion returns HTTP 409 conflict when conflicts exceed maximum 3 attempts', async () => {
      let saveAttempts = 0;
      const mockCartDoc: any = {
        _id: new mongoose.Types.ObjectId('6740000000000000000000c1'),
        user: user1.id,
        items: [] as any[],
        save: async function () {
          saveAttempts++;
          const versionErr: any = new Error('Version conflict on document');
          versionErr.name = 'VersionError';
          throw versionErr;
        },
      };

      (Cart as any).findOne = () => Promise.resolve(mockCartDoc);
      (Project as any).findOne = () => Promise.resolve(mockDroneProject);
      (Project as any).find = () => ({
        lean: () => Promise.resolve([mockDroneProject]),
      });

      const res = await request(app)
        .post('/api/cart/items')
        .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
        .send({ projectId: 'eng-Drone-001', quantity: 1 });

      assert.equal(res.status, 409);
      assert.equal(res.body.success, false);
      assert.match(res.body.message, /modified concurrently|conflict/i);
      assert.equal(saveAttempts, 3, 'Must bound attempts to exactly 3 and never loop infinitely');
    });

    it('28. validation errors and business rule violations are not retried', async () => {
      let saveAttempts = 0;
      const mockCartDoc: any = {
        _id: new mongoose.Types.ObjectId('6740000000000000000000c1'),
        user: user1.id,
        items: [
          {
            project: mockDroneProject._id,
            quantity: 9,
          },
        ],
        save: async function () {
          saveAttempts++;
          return this;
        },
      };

      (Cart as any).findOne = () => Promise.resolve(mockCartDoc);
      (Project as any).findOne = () => Promise.resolve(mockDroneProject);

      const res = await request(app)
        .post('/api/cart/items')
        .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
        .send({ projectId: 'eng-Drone-001', quantity: 3 }); // 9 + 3 = 12 > 10

      assert.equal(res.status, 400);
      assert.equal(res.body.success, false);
      assert.match(res.body.message, /maximum quantity limit/i);
      assert.equal(saveAttempts, 0, 'Validation errors must never trigger save or retry');
    });

    it('29. missing projects return 404 immediately and are not retried', async () => {
      let saveAttempts = 0;
      (Project as any).findOne = () => Promise.resolve(null);
      Cart.prototype.save = async function () {
        saveAttempts++;
        return this;
      };

      const res = await request(app)
        .post('/api/cart/items')
        .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
        .send({ projectId: 'nonexistent-project-slug', quantity: 1 });

      assert.equal(res.status, 404);
      assert.equal(res.body.success, false);
      assert.match(res.body.message, /not found/i);
      assert.equal(saveAttempts, 0, 'Missing project checks must never trigger save or retry');
    });

    it('30. updateItem and removeItem operations safely retry on VersionError', async () => {
      let updateSaveAttempts = 0;
      let removeSaveAttempts = 0;
      let mode: 'update' | 'remove' = 'update';
      const itemId = new mongoose.Types.ObjectId('674000000000000000000011');

      let currentItems: any[] = [
        {
          _id: itemId,
          project: mockDroneProject._id,
          quantity: 1,
          customization: 'Original',
        },
      ];

      (Cart as any).findOne = async () => ({
        _id: new mongoose.Types.ObjectId('6740000000000000000000c1'),
        user: user1.id,
        items: currentItems.map((item) => ({ ...item })),
        save: async function () {
          if (mode === 'update') {
            updateSaveAttempts++;
            if (updateSaveAttempts === 1) {
              const err: any = new Error('VersionError');
              err.name = 'VersionError';
              throw err;
            }
          } else if (mode === 'remove') {
            removeSaveAttempts++;
            if (removeSaveAttempts === 1) {
              const err: any = new Error('VersionError');
              err.name = 'VersionError';
              throw err;
            }
          }
          currentItems = this.items;
          return this;
        },
      });

      (Project as any).find = () => ({
        lean: () => Promise.resolve([mockDroneProject]),
      });

      // 1. Test updateItem retry
      mode = 'update';
      const updateRes = await request(app)
        .patch(`/api/cart/items/${itemId}`)
        .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
        .send({ quantity: 4 });

      assert.equal(updateRes.status, 200);
      assert.equal(updateSaveAttempts, 2);
      assert.equal(currentItems[0].quantity, 4);

      // 2. Test removeItem retry
      mode = 'remove';
      const removeRes = await request(app)
        .delete(`/api/cart/items/${itemId}`)
        .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`);

      assert.equal(removeRes.status, 200);
      assert.equal(removeSaveAttempts, 2);
      assert.equal(currentItems.length, 0);
    });

    it('31. clearCart operation safely retries on VersionError', async () => {
      let clearSaveAttempts = 0;
      const mockCartDoc: any = {
        _id: new mongoose.Types.ObjectId('6740000000000000000000c1'),
        user: user1.id,
        items: [
          {
            _id: new mongoose.Types.ObjectId('674000000000000000000011'),
            project: mockDroneProject._id,
            quantity: 2,
          },
        ],
        save: async function () {
          clearSaveAttempts++;
          if (clearSaveAttempts === 1) {
            const err: any = new Error('VersionError');
            err.name = 'VersionError';
            throw err;
          }
          return this;
        },
      };

      (Cart as any).findOne = () => Promise.resolve(mockCartDoc);

      const res = await request(app)
        .delete('/api/cart')
        .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`);

      assert.equal(res.status, 200);
      assert.equal(clearSaveAttempts, 2);
      assert.deepEqual(res.body.data.cart, {
        items: [],
        subtotal: 0,
        total: 0,
        itemCount: 0,
      });
    });

    it('32. an unrelated duplicate-key error is NOT treated as a concurrency conflict and is not retried', async () => {
      let findOneAndUpdateCalls = 0;
      (Cart as any).findOne = () => Promise.resolve(null);
      (Project as any).findOne = () => Promise.resolve(mockDroneProject);

      (Cart as any).findOneAndUpdate = async () => {
        findOneAndUpdateCalls++;
        const unrelatedDupErr: any = new Error(
          'E11000 duplicate key error collection: test.orders index: orderNumber_1 dup key: { orderNumber: 9999 }'
        );
        unrelatedDupErr.code = 11000;
        unrelatedDupErr.name = 'MongoServerError';
        unrelatedDupErr.keyPattern = { orderNumber: 1 };
        unrelatedDupErr.keyValue = { orderNumber: 9999 };
        throw unrelatedDupErr;
      };

      const res = await request(app)
        .post('/api/cart/items')
        .set('Cookie', `${AUTH_COOKIE_NAME}=${tokenUser1}`)
        .send({ projectId: 'eng-Drone-001', quantity: 1 });

      assert.equal(res.status, 500);
      assert.equal(res.body.success, false);
      assert.equal(res.body.message, 'Failed to add item to cart. Please try again later.');
      assert.equal(findOneAndUpdateCalls, 1, 'Must not retry an unrelated duplicate key error');
    });

    it('33. isConcurrencyConflict correctly classifies VersionError and Cart user duplicate key errors', () => {
      // 1. VersionError cases
      const realVersionErr = new mongoose.Error.VersionError({ _doc: { _id: '6740000000000000000000c1' } } as any, 1, ['items']);
      assert.equal(isConcurrencyConflict(realVersionErr), true);
      assert.equal(isConcurrencyConflict({ name: 'VersionError' }), true);

      // 2. Duplicate key on Cart 'user' index
      assert.equal(
        isConcurrencyConflict({ code: 11000, keyPattern: { user: 1 } }),
        true
      );
      assert.equal(
        isConcurrencyConflict({ code: 11000, keyValue: { user: '6740000000000000000000u1' } }),
        true
      );
      assert.equal(
        isConcurrencyConflict({
          code: 11000,
          message: 'E11000 duplicate key error collection: test.carts index: user_1 dup key: { user: "123" }',
        }),
        true
      );
      assert.equal(
        isConcurrencyConflict({
          message: 'E11000 duplicate key error index: carts.user_1',
        }),
        true
      );
      assert.equal(
        isConcurrencyConflict({
          code: 11000,
          message: 'E11000 duplicate key error collection: carts dup key: { user: ObjectId("123") }',
        }),
        true
      );

      // 3. Unrelated duplicate key errors
      assert.equal(
        isConcurrencyConflict({ code: 11000, keyPattern: { email: 1 } }),
        false
      );
      assert.equal(
        isConcurrencyConflict({ code: 11000, keyPattern: { slug: 1 } }),
        false
      );
      assert.equal(
        isConcurrencyConflict({ code: 11000, keyValue: { email: 'a@b.com' } }),
        false
      );
      assert.equal(
        isConcurrencyConflict({
          code: 11000,
          message: 'E11000 duplicate key error collection: test.users index: email_1 dup key: { email: "a@b.com" }',
        }),
        false
      );

      // 4. Ambiguous or missing index information
      assert.equal(
        isConcurrencyConflict({ code: 11000, message: 'E11000 duplicate key error' }),
        false
      );
      assert.equal(isConcurrencyConflict({ code: 11000 }), false);
      assert.equal(isConcurrencyConflict({ message: 'E11000 duplicate key error' }), false);

      // 5. Other errors or invalid inputs
      assert.equal(isConcurrencyConflict(new Error('MongoNetworkTimeoutException')), false);
      assert.equal(isConcurrencyConflict(new Error('CastError')), false);
      assert.equal(isConcurrencyConflict(null), false);
      assert.equal(isConcurrencyConflict(undefined), false);
      assert.equal(isConcurrencyConflict('some error string'), false);
      assert.equal(isConcurrencyConflict(12345), false);
    });
  });
});
