import dotenv from 'dotenv';
dotenv.config();

import { connectDB, disconnectDB } from '../config/db.js';
import { Category } from '../models/Category.js';
import { Project } from '../models/Project.js';

// The canonical 3 categories and subcategories extracted from the original project
const categoriesData = [
  {
    name: 'Computer Science',
    slug: 'computer-science',
    description:
      'Discover cutting-edge software development and programming projects for computer science and IT students.',
    subcategories: [
      { slug: 'web-development', name: 'Web Development', description: 'Full-stack and frontend web applications.' },
      { slug: 'ai-ml', name: 'AI ML', description: 'Artificial intelligence and machine learning models.' },
      { slug: 'app-development', name: 'App Development', description: 'Cross-platform and native mobile applications.' },
      { slug: 'game-development', name: 'Game Development', description: '2D/3D interactive games and engines.' },
    ],
  },
  {
    name: 'Engineering',
    slug: 'engineering',
    description:
      'Explore innovative engineering projects in Robotics, electronics, and mechanical design for Engineering students.',
    subcategories: [
      { slug: 'drone', name: 'Drone', description: 'UAV, FPV, and aerial photography systems.' },
      { slug: 'rc-devices', name: 'RC Devices', description: 'Remote-controlled vehicles and watercraft.' },
      { slug: 'arduino', name: 'Arduino', description: 'IoT microcontrollers and sensor networks.' },
      { slug: 'robotics', name: 'Robotics', description: 'Autonomous robots and robotic manipulators.' },
    ],
  },
  {
    name: 'Business',
    slug: 'business',
    description:
      'Browse strategic business plans, market research, and Management case studies for business administration students.',
    subcategories: [
      { slug: 'marketing', name: 'Marketing', description: 'Social media and influencer campaign strategies.' },
      { slug: 'finance', name: 'Finance', description: 'Portfolio analysis and financial models.' },
      { slug: 'entrepreneurship', name: 'Entrepreneurship', description: 'Startup business plans and launch strategies.' },
      { slug: 'management', name: 'Management', description: 'Supply chain optimization and market research.' },
    ],
  },
];

// The canonical 20 projects extracted from the original project
const projectsData = [
  // Engineering - Drone
  {
    slug: 'eng-Drone-001',
    title: 'Racing Drone Construction Kit',
    description:
      'High-speed FPV racing Drone with carbon fiber frame, brushless motors, and programmable flight controller.',
    price: 4169.99,
    category: 'Engineering',
    subcategory: 'Drone',
    image: '/projects/drone1.png',
    features: ['Carbon fiber frame', 'Brushless motors', 'Programmable flight controller'],
    rating: 4.5,
    downloads: 1200,
    featured: false,
    difficulty: 'Intermediate' as const,
  },
  {
    slug: 'eng-Drone-002',
    title: 'Aerial Photography Drone',
    description:
      'Stable photography platform with 3-axis gimbal, 4K camera mount and extended flight time battery system.',
    price: 5249.99,
    category: 'Engineering',
    subcategory: 'Drone',
    image: '/projects/drone2.png',
    features: ['3-axis gimbal', '4K camera mount', 'Extended flight time battery'],
    rating: 4.7,
    downloads: 950,
    featured: true,
    difficulty: 'Advanced' as const,
  },

  // Engineering - RC Devices
  {
    slug: 'eng-rc-001',
    title: 'Off-Road RC Crawler',
    description:
      'All-terrain remote-controlled vehicle with suspension system, waterproof electronics, and realistic scaling.',
    price: 4129.99,
    category: 'Engineering',
    subcategory: 'RC Devices',
    image: '/projects/rc1.png',
    features: ['Suspension system', 'Waterproof electronics', 'Realistic scaling'],
    rating: 4.3,
    downloads: 800,
    featured: false,
    difficulty: 'Beginner' as const,
  },
  {
    slug: 'eng-rc-002',
    title: 'RC Speedboat Design',
    description:
      'High-performance water vehicle with hydrodynamic hull design, brushless motor system, and remote control integration.',
    price: 6159.99,
    category: 'Engineering',
    subcategory: 'RC Devices',
    image: '/projects/rc2.png',
    features: ['Hydrodynamic hull design', 'Brushless motor system', 'Remote control integration'],
    rating: 4.6,
    downloads: 700,
    featured: true,
    difficulty: 'Intermediate' as const,
  },

  // Engineering - Arduino
  {
    slug: 'eng-Arduino-001',
    title: 'Smart Home Automation System',
    description:
      'A comprehensive IoT-based home automation system with Arduino and Raspberry Pi integration. Includes temperature, humidity, and motion sensors with mobile app control.',
    price: 5149.99,
    category: 'Engineering',
    subcategory: 'Arduino',
    image: '/projects/arduino1.png',
    features: ['Temperature sensors', 'Humidity sensors', 'Motion sensors', 'Mobile app control'],
    rating: 4.8,
    downloads: 1500,
    featured: true,
    difficulty: 'Intermediate' as const,
  },
  {
    slug: 'eng-Arduino-002',
    title: 'Automated Plant Watering System',
    description:
      'Arduino-based system with soil moisture sensors, water pump control, and mobile notifications for plant care.',
    price: 2389.99,
    category: 'Engineering',
    subcategory: 'Arduino',
    image: '/projects/arduino2.png',
    features: ['Soil moisture sensors', 'Water pump control', 'Mobile notifications'],
    rating: 4.3,
    downloads: 1200,
    featured: false,
    difficulty: 'Beginner' as const,
  },

  // Engineering - Robotics
  {
    slug: 'eng-Robotics-001',
    title: 'Robotic Arm with Computer Vision',
    description:
      '6-DOF robotic arm with camera integration for object recognition and manipulation tasks.',
    price: 4229.99,
    category: 'Engineering',
    subcategory: 'Robotics',
    image: '/projects/robotics1.png',
    features: ['6-DOF robotic arm', 'Camera integration', 'Object recognition', 'Manipulation tasks'],
    rating: 4.5,
    downloads: 900,
    featured: true,
    difficulty: 'Advanced' as const,
  },
  {
    slug: 'eng-Robotics-002',
    title: 'Autonomous Line-Following Robot',
    description:
      'Self-contained robot with IR sensors, PID control system, and obstacle avoidance capabilities.',
    price: 5119.99,
    category: 'Engineering',
    subcategory: 'Robotics',
    image: '/projects/robotics2.png',
    features: ['IR sensors', 'PID control system', 'Obstacle avoidance'],
    rating: 4.6,
    downloads: 1100,
    featured: false,
    difficulty: 'Intermediate' as const,
  },

  // Computer Science - Web Development
  {
    slug: 'cs-web-001',
    title: 'E-commerce Website with Admin Dashboard',
    description:
      'Fully functional e-commerce platform with user authentication, product Management, shopping cart, and admin dashboard. Built with React and Node.js.',
    price: 4179.99,
    category: 'Computer Science',
    subcategory: 'Web Development',
    image: '/projects/web1.png',
    features: ['User authentication', 'Product Management', 'Shopping cart', 'Admin dashboard'],
    rating: 4.5,
    downloads: 1200,
    featured: true,
    difficulty: 'Intermediate' as const,
  },
  {
    slug: 'cs-web-002',
    title: 'Real-time Collaboration Platform',
    description:
      'Multi-user document editing system with WebSockets, user presence indicators, and version history.',
    price: 4189.99,
    category: 'Computer Science',
    subcategory: 'Web Development',
    image: '/projects/web2.png',
    features: ['WebSockets', 'User presence indicators', 'Version history'],
    rating: 4.6,
    downloads: 1300,
    featured: false,
    difficulty: 'Advanced' as const,
  },

  // Computer Science - AI & ML
  {
    slug: 'cs-ai-001',
    title: 'Machine Learning Image Classifier',
    description:
      'Image classification system using TensorFlow/PyTorch with pre-trained models and custom dataset training capabilities.',
    price: 5159.99,
    category: 'Computer Science',
    subcategory: 'AI ML',
    image: '/projects/ai1.png',
    features: ['TensorFlow/PyTorch', 'Pre-trained models', 'Custom dataset training'],
    rating: 4.8,
    downloads: 1400,
    featured: true,
    difficulty: 'Advanced' as const,
  },
  {
    slug: 'cs-ai-002',
    title: 'Natural Language Processing Chatbot',
    description:
      'Conversational AI with intent recognition, entity extraction, and integration capabilities for websites and applications.',
    price: 5199.99,
    category: 'Computer Science',
    subcategory: 'AI ML',
    image: '/projects/ai2.png',
    features: ['Intent recognition', 'Entity extraction', 'Integration capabilities'],
    rating: 4.7,
    downloads: 1500,
    featured: false,
    difficulty: 'Intermediate' as const,
  },

  // Computer Science - App Development
  {
    slug: 'cs-app-001',
    title: 'Mobile App Development - Fitness Tracker',
    description:
      'Cross-platform fitness tracking mobile application with step counter, workout planner, and nutrition tracker. Built with React Native.',
    price: 6189.99,
    category: 'Computer Science',
    subcategory: 'App Development',
    image: '/projects/app1.png',
    features: ['Step counter', 'Workout planner', 'Nutrition tracker'],
    rating: 4.9,
    downloads: 1600,
    featured: true,
    difficulty: 'Intermediate' as const,
  },
  {
    slug: 'cs-app-002',
    title: 'Location-Based Social Media App',
    description:
      'Mobile application with geolocation services, user profiles, photo sharing, and real-time notifications.',
    price: 5209.99,
    category: 'Computer Science',
    subcategory: 'App Development',
    image: '/projects/app2.png',
    features: ['Geolocation services', 'User profiles', 'Photo sharing', 'Real-time notifications'],
    rating: 4.6,
    downloads: 1200,
    featured: false,
    difficulty: 'Intermediate' as const,
  },

  // Computer Science - Game Development
  {
    slug: 'cs-game-001',
    title: '2D Platformer Game Development',
    description:
      'Complete game with character animations, level design, physics implementation, and scoring system using Unity.',
    price: 4149.99,
    category: 'Computer Science',
    subcategory: 'Game Development',
    image: '/projects/game1.png',
    features: ['Character animations', 'Level design', 'Physics implementation', 'Scoring system'],
    rating: 4.5,
    downloads: 1100,
    featured: true,
    difficulty: 'Beginner' as const,
  },
  {
    slug: 'cs-game-002',
    title: 'Multiplayer Strategy Game',
    description:
      'Turn-based online multiplayer game with matchmaking, player progression, and strategic gameplay elements.',
    price: 5179.99,
    category: 'Computer Science',
    subcategory: 'Game Development',
    image: '/projects/game2.png',
    features: ['Matchmaking', 'Player progression', 'Strategic gameplay'],
    rating: 4.7,
    downloads: 1300,
    featured: false,
    difficulty: 'Advanced' as const,
  },

  // Business - Marketing
  {
    slug: 'bus-Marketing-001',
    title: 'Social Media Marketing Campaign',
    description:
      'Complete social media Marketing strategy with content calendar, ad campaign design, analytics setup, and ROI measurement plan.',
    price: 3139.99,
    category: 'Business',
    subcategory: 'Marketing',
    image: '/projects/marketing1.png',
    features: ['Content calendar', 'Ad campaign design', 'Analytics setup', 'ROI measurement'],
    rating: 4.4,
    downloads: 900,
    featured: false,
    difficulty: 'Beginner' as const,
  },
  {
    slug: 'bus-Marketing-002',
    title: 'Influencer Marketing Strategy',
    description:
      'Comprehensive plan for brand partnerships, influencer selection criteria, campaign metrics, and performance tracking.',
    price: 3129.99,
    category: 'Business',
    subcategory: 'Marketing',
    image: '/projects/marketing2.png',
    features: ['Brand partnerships', 'Influencer selection', 'Campaign metrics', 'Performance tracking'],
    rating: 4.3,
    downloads: 850,
    featured: true,
    difficulty: 'Intermediate' as const,
  },

  // Business - Finance
  {
    slug: 'bus-Finance-001',
    title: 'Investment Portfolio Analysis',
    description:
      'Detailed financial analysis with asset allocation recommendations, risk assessment, and projected returns calculation.',
    price: 3149.99,
    category: 'Business',
    subcategory: 'Finance',
    image: '/projects/finance1.png',
    features: ['Asset allocation', 'Risk assessment', 'Projected returns'],
    rating: 4.5,
    downloads: 1000,
    featured: false,
    difficulty: 'Intermediate' as const,
  },
  {
    slug: 'bus-Finance-002',
    title: 'Financial Forecasting Model',
    description:
      'Advanced Excel/Google Sheets model for Business financial projections, cash flow analysis, and scenario planning.',
    price: 4159.99,
    category: 'Business',
    subcategory: 'Finance',
    image: '/projects/finance2.png',
    features: ['Financial projections', 'Cash flow analysis', 'Scenario planning'],
    rating: 4.6,
    downloads: 1100,
    featured: true,
    difficulty: 'Advanced' as const,
  },

  // Business - Entrepreneurship
  {
    slug: 'bus-entrepreneur-001',
    title: 'Business Plan Development',
    description:
      'Comprehensive Business plan including market analysis, financial projections, Marketing strategy, and operational plan for a startup Business.',
    price: 3129.99,
    category: 'Business',
    subcategory: 'Entrepreneurship',
    image: '/projects/entrepreneurship1.png',
    features: ['Market analysis', 'Financial projections', 'Marketing strategy', 'Operational plan'],
    rating: 4.4,
    downloads: 950,
    featured: false,
    difficulty: 'Beginner' as const,
  },
  {
    slug: 'bus-entrepreneur-002',
    title: 'Product Launch Strategy',
    description:
      'Go-to-market plan for new product introduction with pricing strategy, distribution channels, and promotional campaign.',
    price: 4119.99,
    category: 'Business',
    subcategory: 'Entrepreneurship',
    image: '/projects/entrepreneurship2.png',
    features: ['Pricing strategy', 'Distribution channels', 'Promotional campaign'],
    rating: 4.5,
    downloads: 1050,
    featured: true,
    difficulty: 'Intermediate' as const,
  },

  // Business - Management
  {
    slug: 'bus-Management-001',
    title: 'Market Research Analysis',
    description:
      'In-depth market research report with consumer behavior analysis, competitor evaluation, and strategic recommendations.',
    price: 3149.99,
    category: 'Business',
    subcategory: 'Management',
    image: '/projects/management1.png',
    features: ['Consumer behavior analysis', 'Competitor evaluation', 'Strategic recommendations'],
    rating: 4.4,
    downloads: 900,
    featured: false,
    difficulty: 'Beginner' as const,
  },
  {
    slug: 'bus-Management-002',
    title: 'Supply Chain Optimization Plan',
    description:
      'Analysis and improvement strategy for logistics, inventory Management, and vendor relationships with cost reduction targets.',
    price: 4169.99,
    category: 'Business',
    subcategory: 'Management',
    image: '/projects/management2.png',
    features: ['Logistics analysis', 'Inventory Management', 'Vendor relationships'],
    rating: 4.5,
    downloads: 1000,
    featured: true,
    difficulty: 'Advanced' as const,
  },
];

export async function seedCatalog(): Promise<{ categoriesCount: number; projectsCount: number }> {
  console.log('[Seed] Starting catalog seeding...');

  // 1. Seed categories using idempotent upsert
  let categoriesCount = 0;
  for (const cat of categoriesData) {
    await Category.findOneAndUpdate(
      { slug: cat.slug },
      {
        $set: {
          name: cat.name,
          slug: cat.slug,
          description: cat.description,
          subcategories: cat.subcategories,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    categoriesCount++;
  }
  console.log(`[Seed] Successfully processed ${categoriesCount} categories`);

  // 2. Seed projects using idempotent upsert
  let projectsCount = 0;
  for (const proj of projectsData) {
    await Project.findOneAndUpdate(
      { slug: proj.slug },
      {
        $set: {
          slug: proj.slug,
          title: proj.title,
          description: proj.description,
          features: proj.features,
          category: proj.category,
          subcategory: proj.subcategory,
          price: proj.price,
          image: proj.image,
          rating: proj.rating,
          downloads: proj.downloads,
          featured: proj.featured,
          difficulty: proj.difficulty,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    projectsCount++;
  }
  console.log(`[Seed] Successfully processed ${projectsCount} projects`);

  return { categoriesCount, projectsCount };
}

// Self-invoking runner when executed as a CLI script
async function run() {
  try {
    await connectDB();
    const result = await seedCatalog();
    console.log(
      `[Seed] Finished successfully! ${result.categoriesCount} categories and ${result.projectsCount} projects are up-to-date.`
    );
    await disconnectDB();
    process.exit(0);
  } catch (error) {
    console.error('[Seed] Seeding failed:', error instanceof Error ? error.message : error);
    await disconnectDB().catch(() => {});
    process.exit(1);
  }
}

// Only auto-run if directly executed via CLI
if (process.argv[1]?.includes('seedProjects')) {
  run();
}
