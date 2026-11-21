import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import app from '../app.js';
import { Project } from '../models/Project.js';

// Sample fixture projects for testing
const mockProjectsData = [
  {
    _id: '674000000000000000000001',
    slug: 'eng-Drone-001',
    title: 'Racing Drone Construction Kit',
    description: 'High-speed FPV racing Drone with carbon fiber frame',
    features: ['Carbon fiber frame', 'Brushless motors'],
    category: 'Engineering',
    subcategory: 'Drone',
    price: 4169.99,
    image: '/projects/drone1.png',
    rating: 4.5,
    downloads: 1200,
    featured: false,
    difficulty: 'Intermediate',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  },
  {
    _id: '674000000000000000000002',
    slug: 'eng-Drone-002',
    title: 'Aerial Photography Drone',
    description: 'Stable photography platform with 3-axis gimbal',
    features: ['3-axis gimbal', '4K camera mount'],
    category: 'Engineering',
    subcategory: 'Drone',
    price: 5249.99,
    image: '/projects/drone2.png',
    rating: 4.7,
    downloads: 950,
    featured: true,
    difficulty: 'Advanced',
    createdAt: new Date('2026-01-02T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
  },
  {
    _id: '674000000000000000000003',
    slug: 'cs-web-001',
    title: 'Modern E-Commerce Portal',
    description: 'Full-stack reactive web shop with microservices',
    features: ['Shopping cart', 'Order tracking'],
    category: 'Computer Science',
    subcategory: 'Web Development',
    price: 3299.99,
    image: '/projects/web1.png',
    rating: 4.8,
    downloads: 1500,
    featured: true,
    difficulty: 'Beginner',
    createdAt: new Date('2026-01-03T00:00:00.000Z'),
    updatedAt: new Date('2026-01-03T00:00:00.000Z'),
  },
];

// Helper to construct a chainable mock Query object
function createMockQuery(data: any[], spies: any = {}) {
  let result = [...data];
  const queryObj: any = {
    sort: (sortOptions: any) => {
      spies.sort = sortOptions;
      if (typeof spies.onSort === 'function') spies.onSort(sortOptions);
      return queryObj;
    },
    skip: (skipCount: number) => {
      spies.skip = skipCount;
      if (typeof spies.onSkip === 'function') spies.onSkip(skipCount);
      result = result.slice(skipCount);
      return queryObj;
    },
    limit: (limitCount: number) => {
      spies.limit = limitCount;
      if (typeof spies.onLimit === 'function') spies.onLimit(limitCount);
      result = result.slice(0, limitCount);
      return queryObj;
    },
    lean: () => queryObj,
    then: (resolve: any, reject?: any) => Promise.resolve(result).then(resolve, reject),
  };
  return queryObj;
}

function createMockFindOne(item: any, querySpy?: (q: any) => void) {
  const queryObj: any = {
    lean: () => queryObj,
    then: (resolve: any, reject?: any) => {
      if (querySpy) querySpy(item);
      return Promise.resolve(item).then(resolve, reject);
    },
  };
  return queryObj;
}

describe('Project Catalog REST API Integration', () => {
  const originalFind = Project.find;
  const originalCountDocuments = Project.countDocuments;
  const originalFindOne = Project.findOne;

  afterEach(() => {
    // Restore original Mongoose model methods after each test
    Project.find = originalFind;
    Project.countDocuments = originalCountDocuments;
    Project.findOne = originalFindOne;
  });

  describe('GET /api/projects - General Catalog & Pagination', () => {
    it('returns 200 with paginated list of projects and metadata on success', async () => {
      const spies: any = {};
      (Project as any).find = (filter: any) => {
        spies.filter = filter;
        return createMockQuery(mockProjectsData, spies);
      };
      (Project as any).countDocuments = async () => mockProjectsData.length;

      const res = await request(app).get('/api/projects').expect(200);

      assert.equal(res.body.success, true);
      assert.ok(Array.isArray(res.body.data.projects));
      assert.equal(res.body.data.projects.length, 3);
      assert.equal(res.body.data.projects[0].id, 'eng-Drone-001');
      assert.equal(res.body.data.projects[0].slug, 'eng-Drone-001');

      // Pagination metadata checks
      const pagination = res.body.data.pagination;
      assert.equal(pagination.page, 1);
      assert.equal(pagination.limit, 12);
      assert.equal(pagination.total, 3);
      assert.equal(pagination.totalPages, 1);
      assert.equal(pagination.hasNextPage, false);
      assert.equal(pagination.hasPrevPage, false);
    });

    it('returns empty array and appropriate metadata when catalog has 0 projects', async () => {
      (Project as any).find = () => createMockQuery([]);
      (Project as any).countDocuments = async () => 0;

      const res = await request(app).get('/api/projects').expect(200);

      assert.equal(res.body.success, true);
      assert.equal(res.body.data.projects.length, 0);
      assert.equal(res.body.data.pagination.total, 0);
      assert.equal(res.body.data.pagination.totalPages, 0);
      assert.equal(res.body.data.pagination.hasNextPage, false);
      assert.equal(res.body.data.pagination.hasPrevPage, false);
    });

    it('handles custom pagination parameters correctly (page & limit)', async () => {
      const spies: any = {};
      (Project as any).find = (filter: any) => {
        spies.filter = filter;
        return createMockQuery(mockProjectsData, spies);
      };
      (Project as any).countDocuments = async () => 24;

      const res = await request(app)
        .get('/api/projects?page=2&limit=5')
        .expect(200);

      assert.equal(res.body.success, true);
      assert.equal(spies.skip, 5); // (page 2 - 1) * 5
      assert.equal(spies.limit, 5);
      assert.equal(res.body.data.pagination.page, 2);
      assert.equal(res.body.data.pagination.limit, 5);
      assert.equal(res.body.data.pagination.total, 24);
      assert.equal(res.body.data.pagination.totalPages, 5);
      assert.equal(res.body.data.pagination.hasNextPage, true);
      assert.equal(res.body.data.pagination.hasPrevPage, true);
    });

    it('rejects invalid page values with HTTP 400', async () => {
      const resZero = await request(app).get('/api/projects?page=0').expect(400);
      assert.equal(resZero.body.success, false);
      assert.equal(resZero.body.message, 'Validation failed');
      assert.ok(resZero.body.errors.some((e: any) => e.field === 'page'));

      const resNegative = await request(app).get('/api/projects?page=-3').expect(400);
      assert.equal(resNegative.body.success, false);

      const resString = await request(app).get('/api/projects?page=abc').expect(400);
      assert.equal(resString.body.success, false);
    });

    it('rejects invalid limit values with HTTP 400 (under 1 or exceeding max limit of 50)', async () => {
      const resZero = await request(app).get('/api/projects?limit=0').expect(400);
      assert.equal(resZero.body.success, false);
      assert.ok(resZero.body.errors.some((e: any) => e.field === 'limit'));

      const resOverMax = await request(app).get('/api/projects?limit=100').expect(400);
      assert.equal(resOverMax.body.success, false);
      assert.ok(resOverMax.body.errors.some((e: any) => e.field === 'limit'));
    });
  });

  describe('GET /api/projects - Filtering & Search', () => {
    it('applies safe regex search across title, description, category, and subcategory', async () => {
      let capturedFilter: any = null;
      (Project as any).find = (filter: any) => {
        capturedFilter = filter;
        return createMockQuery(mockProjectsData);
      };
      (Project as any).countDocuments = async () => mockProjectsData.length;

      const res = await request(app).get('/api/projects?search=drone').expect(200);

      assert.equal(res.body.success, true);
      assert.ok(capturedFilter.$or);
      assert.equal(capturedFilter.$or.length, 4);
      assert.ok(capturedFilter.$or[0].title.$regex instanceof RegExp);
      assert.ok(capturedFilter.$or[0].title.$regex.test('Racing Drone'));
    });

    it('escapes special regex characters in search parameter to prevent ReDoS', async () => {
      let capturedFilter: any = null;
      (Project as any).find = (filter: any) => {
        capturedFilter = filter;
        return createMockQuery(mockProjectsData);
      };
      (Project as any).countDocuments = async () => 0;

      // Special characters: .*+?^${}()|[]\
      await request(app).get('/api/projects?search=[drone](kit)+.*').expect(200);

      assert.ok(capturedFilter.$or);
      const regex: RegExp = capturedFilter.$or[0].title.$regex;
      // Pattern should be escaped, not executing arbitrary quantifier
      assert.ok(regex.source.includes('\\[drone\\]'));
    });

    it('filters by category and subcategory safely', async () => {
      let capturedFilter: any = null;
      (Project as any).find = (filter: any) => {
        capturedFilter = filter;
        return createMockQuery([mockProjectsData[0]]);
      };
      (Project as any).countDocuments = async () => 1;

      const res = await request(app)
        .get('/api/projects?category=Engineering&subcategory=Drone')
        .expect(200);

      assert.equal(res.body.success, true);
      assert.equal(capturedFilter.category, 'Engineering');
      assert.equal(capturedFilter.subcategory, 'Drone');
    });

    it('filters by valid difficulty level', async () => {
      let capturedFilter: any = null;
      (Project as any).find = (filter: any) => {
        capturedFilter = filter;
        return createMockQuery([mockProjectsData[1]]);
      };
      (Project as any).countDocuments = async () => 1;

      const res = await request(app)
        .get('/api/projects?difficulty=Advanced')
        .expect(200);

      assert.equal(res.body.success, true);
      assert.equal(capturedFilter.difficulty, 'Advanced');
    });

    it('rejects invalid difficulty values with HTTP 400', async () => {
      const res = await request(app)
        .get('/api/projects?difficulty=Expert')
        .expect(400);

      assert.equal(res.body.success, false);
      assert.equal(res.body.message, 'Validation failed');
      assert.ok(res.body.errors.some((e: any) => e.field === 'difficulty'));
    });

    it('filters by featured flag (true / false)', async () => {
      let capturedFilter: any = null;
      (Project as any).find = (filter: any) => {
        capturedFilter = filter;
        return createMockQuery([mockProjectsData[1], mockProjectsData[2]]);
      };
      (Project as any).countDocuments = async () => 2;

      const resTrue = await request(app)
        .get('/api/projects?featured=true')
        .expect(200);

      assert.equal(resTrue.body.success, true);
      assert.equal(capturedFilter.featured, true);

      await request(app).get('/api/projects?featured=false').expect(200);
      assert.equal(capturedFilter.featured, false);
    });

    it('rejects invalid featured values with HTTP 400', async () => {
      const res = await request(app)
        .get('/api/projects?featured=yes')
        .expect(400);

      assert.equal(res.body.success, false);
      assert.ok(res.body.errors.some((e: any) => e.field === 'featured'));
    });
  });

  describe('GET /api/projects - Sorting', () => {
    it('applies supported sort criteria correctly', async () => {
      const testCases = [
        { sort: 'price_asc', expected: { price: 1, createdAt: -1 } },
        { sort: 'price_desc', expected: { price: -1, createdAt: -1 } },
        { sort: 'rating', expected: { rating: -1, downloads: -1, createdAt: -1 } },
        { sort: 'downloads', expected: { downloads: -1, rating: -1, createdAt: -1 } },
        { sort: 'newest', expected: { createdAt: -1 } },
      ];

      for (const tc of testCases) {
        let capturedSort: any = null;
        (Project as any).find = () => {
          return createMockQuery(mockProjectsData, {
            onSort: (s: any) => {
              capturedSort = s;
            },
          });
        };
        (Project as any).countDocuments = async () => mockProjectsData.length;

        const res = await request(app)
          .get(`/api/projects?sort=${tc.sort}`)
          .expect(200);

        assert.equal(res.body.success, true);
        assert.deepEqual(capturedSort, tc.expected);
      }
    });

    it('rejects unsupported sort options with HTTP 400', async () => {
      const res = await request(app)
        .get('/api/projects?sort=unsupported_sort')
        .expect(400);

      assert.equal(res.body.success, false);
      assert.ok(res.body.errors.some((e: any) => e.field === 'sort'));
    });
  });

  describe('GET /api/projects/featured', () => {
    it('returns featured projects with validated limit and does not get caught by /:id', async () => {
      let capturedFilter: any = null;
      let capturedLimit: number = 0;

      (Project as any).find = (filter: any) => {
        capturedFilter = filter;
        return createMockQuery(
          mockProjectsData.filter((p) => p.featured),
          {
            onLimit: (l: number) => {
              capturedLimit = l;
            },
          }
        );
      };

      const res = await request(app)
        .get('/api/projects/featured?limit=6')
        .expect(200);

      assert.equal(res.body.success, true);
      assert.ok(Array.isArray(res.body.data.projects));
      assert.deepEqual(capturedFilter, { featured: true });
      assert.equal(capturedLimit, 6);
      // Verify all returned projects have featured === true
      for (const p of res.body.data.projects) {
        assert.equal(p.featured, true);
      }
    });

    it('rejects invalid limit on featured endpoint with HTTP 400', async () => {
      const res = await request(app)
        .get('/api/projects/featured?limit=0')
        .expect(400);

      assert.equal(res.body.success, false);
    });
  });

  describe('GET /api/projects/:id', () => {
    it('returns 200 and project data when queried by canonical slug ID', async () => {
      (Project as any).findOne = () => createMockFindOne(mockProjectsData[0]);

      const res = await request(app)
        .get('/api/projects/eng-Drone-001')
        .expect(200);

      assert.equal(res.body.success, true);
      assert.equal(res.body.data.project.id, 'eng-Drone-001');
      assert.equal(res.body.data.project.slug, 'eng-Drone-001');
      assert.equal(res.body.data.project.title, 'Racing Drone Construction Kit');
      assert.equal(res.body.data.project.price, 4169.99);
      assert.equal(res.body.data.project.difficulty, 'Intermediate');
    });

    it('returns 200 when queried by valid 24-character hex MongoDB ObjectId', async () => {
      (Project as any).findOne = () => createMockFindOne(mockProjectsData[1]);

      const res = await request(app)
        .get('/api/projects/674000000000000000000002')
        .expect(200);

      assert.equal(res.body.success, true);
      assert.equal(res.body.data.project.slug, 'eng-Drone-002');
    });

    it('returns 404 when project identifier is not found in database', async () => {
      (Project as any).findOne = () => createMockFindOne(null);

      const res = await request(app)
        .get('/api/projects/non-existent-id-999')
        .expect(404);

      assert.equal(res.body.success, false);
      assert.ok(res.body.message.includes('Project not found'));
    });
  });

  describe('Database Error Handling', () => {
    it('handles database errors on GET /api/projects gracefully with HTTP 500 without leaking stack traces', async () => {
      (Project as any).find = () => {
        throw new Error('MongoNetworkError: connection timed out');
      };

      const res = await request(app).get('/api/projects').expect(500);

      assert.equal(res.body.success, false);
      assert.equal(
        res.body.message,
        'Failed to retrieve projects. Please try again later.'
      );
      assert.equal(res.body.error, undefined);
    });

    it('handles database errors on GET /api/projects/:id gracefully with HTTP 500', async () => {
      (Project as any).findOne = () => {
        throw new Error('MongooseServerSelectionError: server closed');
      };

      const res = await request(app)
        .get('/api/projects/eng-Drone-001')
        .expect(500);

      assert.equal(res.body.success, false);
      assert.equal(
        res.body.message,
        'Failed to retrieve project. Please try again later.'
      );
      assert.equal(res.body.error, undefined);
    });

    it('handles database errors on GET /api/projects/featured gracefully with HTTP 500', async () => {
      (Project as any).find = () => {
        throw new Error('MongoTimeoutException');
      };

      const res = await request(app)
        .get('/api/projects/featured')
        .expect(500);

      assert.equal(res.body.success, false);
      assert.equal(
        res.body.message,
        'Failed to retrieve featured projects. Please try again later.'
      );
    });
  });
});
