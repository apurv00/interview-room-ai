export interface DesignProblem {
  id: string
  title: string
  description: string
  requirements: string[]
  expectedComponents: string[]
  difficulty: 'easy' | 'medium' | 'hard'
  applicableDomains: string[]
  hints: string[]
  expectedTimeMinutes: number
  tags: string[]
}

export const DESIGN_PROBLEMS: DesignProblem[] = [
  // ─── EASY ─────────────────────────────────────────────────────────────────

  {
    id: 'url-shortener',
    title: 'Design a URL Shortener',
    description: 'Design a URL shortening service like bit.ly. Users should be able to submit a long URL and receive a shortened URL. When someone visits the short URL, they should be redirected to the original URL.',
    requirements: [
      'Shorten a given URL to a unique short URL',
      'Redirect short URLs to the original URL',
      'Handle high read throughput (100:1 read-to-write ratio)',
      'Short URLs should be as short as possible',
      'Analytics: track click counts per URL',
    ],
    expectedComponents: ['client', 'load_balancer', 'web_server', 'database', 'cache'],
    difficulty: 'easy',
    applicableDomains: ['backend', 'frontend', 'devops'],
    hints: [
      'Consider how to generate unique short codes (hashing vs counter).',
      'Think about caching for frequently accessed URLs.',
      'How would you handle URL collisions?',
    ],
    expectedTimeMinutes: 15,
    tags: ['caching', 'hashing', 'databases'],
  },
  {
    id: 'paste-bin',
    title: 'Design a Pastebin',
    description: 'Design a Pastebin-like service where users can store plain text and get a unique URL to share it. Pastes can optionally have an expiration time.',
    requirements: [
      'Users can create a paste with plain text content',
      'Each paste gets a unique shareable URL',
      'Support paste expiration (e.g., 1 hour, 1 day, never)',
      'Handle up to 5M pastes per day',
      'Read-heavy workload (5:1 read-to-write)',
    ],
    expectedComponents: ['client', 'load_balancer', 'app_server', 'database', 'storage'],
    difficulty: 'easy',
    applicableDomains: ['backend', 'frontend'],
    hints: [
      'How would you store large text blobs efficiently?',
      'Consider a cleanup service for expired pastes.',
      'Think about the key generation strategy.',
    ],
    expectedTimeMinutes: 12,
    tags: ['storage', 'key-generation', 'TTL'],
  },
  {
    id: 'rate-limiter',
    title: 'Design a Rate Limiter',
    description: 'Design an API rate limiter that can be used across multiple services. It should throttle requests based on configurable rules (e.g., 100 requests per minute per user).',
    requirements: [
      'Limit requests per user/IP within a time window',
      'Support multiple rate limiting rules',
      'Low latency — rate check must be fast',
      'Distributed: work across multiple API servers',
      'Return appropriate headers (X-RateLimit-Remaining, Retry-After)',
    ],
    expectedComponents: ['client', 'api_gateway', 'app_server', 'cache'],
    difficulty: 'easy',
    applicableDomains: ['backend', 'devops', 'sdet'],
    hints: [
      'Compare token bucket vs sliding window algorithms.',
      'Redis is commonly used for distributed rate limiting.',
      'Where should the rate limiter sit in your architecture?',
    ],
    expectedTimeMinutes: 12,
    tags: ['rate-limiting', 'distributed-systems', 'caching'],
  },

  // ─── MEDIUM ───────────────────────────────────────────────────────────────

  {
    id: 'chat-application',
    title: 'Design a Chat Application',
    description: 'Design a real-time chat application like WhatsApp or Slack. Users should be able to send 1-on-1 messages and create group chats with real-time delivery.',
    requirements: [
      'Real-time 1-on-1 messaging',
      'Group chats (up to 500 members)',
      'Online/offline status indicators',
      'Message delivery receipts (sent, delivered, read)',
      'Message history and search',
      'Support for 50M daily active users',
    ],
    expectedComponents: ['client', 'load_balancer', 'api_gateway', 'app_server', 'database', 'cache', 'message_queue', 'notification'],
    difficulty: 'medium',
    applicableDomains: ['backend', 'frontend', 'devops'],
    hints: [
      'Consider WebSockets vs long polling for real-time delivery.',
      'How do you handle message ordering in group chats?',
      'Think about offline message queuing and sync.',
    ],
    expectedTimeMinutes: 20,
    tags: ['real-time', 'websockets', 'message-queue', 'fan-out'],
  },
  {
    id: 'news-feed',
    title: 'Design a News Feed',
    description: 'Design a social media news feed system like Facebook or Twitter. Users see a personalized feed of posts from people they follow, ranked by relevance and recency.',
    requirements: [
      'Users can create posts (text, images)',
      'Users see posts from people they follow',
      'Feed is ranked by relevance + recency',
      'Support likes, comments, and shares',
      'Handle 500M users, 10M+ posts per day',
      'Feed generation should be fast (<500ms)',
    ],
    expectedComponents: ['client', 'cdn', 'load_balancer', 'app_server', 'database', 'cache', 'message_queue', 'storage'],
    difficulty: 'medium',
    applicableDomains: ['backend', 'frontend', 'data-science'],
    hints: [
      'Compare fan-out-on-write vs fan-out-on-read.',
      'How do you handle celebrities with millions of followers?',
      'Think about caching strategies for the feed.',
    ],
    expectedTimeMinutes: 20,
    tags: ['fan-out', 'caching', 'ranking', 'social-graph'],
  },
  {
    id: 'file-storage',
    title: 'Design a Cloud File Storage',
    description: 'Design a cloud file storage service like Google Drive or Dropbox. Users can upload, download, and share files with synchronization across devices.',
    requirements: [
      'Upload and download files (up to 10GB)',
      'File syncing across multiple devices',
      'File sharing with permissions (view, edit)',
      'Version history for files',
      'Handle 50M users with 500M files total',
    ],
    expectedComponents: ['client', 'cdn', 'load_balancer', 'app_server', 'database', 'storage', 'message_queue', 'notification'],
    difficulty: 'medium',
    applicableDomains: ['backend', 'frontend', 'devops'],
    hints: [
      'How do you handle large file uploads? (chunking)',
      'Consider a metadata service vs a block storage service.',
      'Think about conflict resolution for concurrent edits.',
    ],
    expectedTimeMinutes: 20,
    tags: ['file-storage', 'chunking', 'sync', 'CDN'],
  },
  {
    id: 'notification-system',
    title: 'Design a Notification System',
    description: 'Design a scalable notification system that supports push notifications, email, SMS, and in-app notifications across multiple platforms.',
    requirements: [
      'Support push, email, SMS, and in-app channels',
      'User notification preferences (opt-in/out per channel)',
      'Priority levels (urgent, normal, low)',
      'Rate limiting to prevent notification spam',
      'Handle 10M notifications per day',
      'Delivery tracking and analytics',
    ],
    expectedComponents: ['api_gateway', 'app_server', 'message_queue', 'database', 'cache', 'notification', 'monitoring'],
    difficulty: 'medium',
    applicableDomains: ['backend', 'devops'],
    hints: [
      'Think about how to prioritize and batch notifications.',
      'Consider using a message queue for async delivery.',
      'How do you handle third-party API failures (email/SMS providers)?',
    ],
    expectedTimeMinutes: 18,
    tags: ['message-queue', 'priority', 'multi-channel'],
  },

  // ─── HARD ─────────────────────────────────────────────────────────────────

  {
    id: 'video-streaming',
    title: 'Design a Video Streaming Platform',
    description: 'Design a video streaming platform like YouTube or Netflix. Users can upload videos, which are processed and served to millions of viewers with adaptive bitrate streaming.',
    requirements: [
      'Video upload and processing (transcoding to multiple resolutions)',
      'Adaptive bitrate streaming',
      'Content delivery via CDN for low latency',
      'Search and recommendation engine',
      'Handle 1B daily video views',
      'Support live streaming',
    ],
    expectedComponents: ['client', 'cdn', 'load_balancer', 'api_gateway', 'app_server', 'database', 'storage', 'message_queue', 'search', 'cache'],
    difficulty: 'hard',
    applicableDomains: ['backend', 'frontend', 'devops', 'data-science'],
    hints: [
      'How would you handle video transcoding at scale?',
      'Think about CDN placement and cache invalidation.',
      'Consider separate read and write paths.',
    ],
    expectedTimeMinutes: 25,
    tags: ['CDN', 'transcoding', 'streaming', 'search'],
  },
  {
    id: 'distributed-cache',
    title: 'Design a Distributed Cache',
    description: 'Design a distributed caching system like Memcached or Redis. The cache should support multiple nodes, consistent hashing, and handle node failures gracefully.',
    requirements: [
      'Key-value store with GET/SET/DELETE operations',
      'Distributed across multiple nodes',
      'Consistent hashing for data distribution',
      'Handle node failures with replication',
      'Support TTL (time-to-live) for entries',
      'Sub-millisecond read latency',
    ],
    expectedComponents: ['client', 'app_server', 'cache', 'monitoring'],
    difficulty: 'hard',
    applicableDomains: ['backend', 'devops'],
    hints: [
      'How does consistent hashing work with virtual nodes?',
      'Consider the trade-off between consistency and availability.',
      'How do you handle cache stampede?',
    ],
    expectedTimeMinutes: 25,
    tags: ['distributed-systems', 'consistent-hashing', 'replication'],
  },
  {
    id: 'search-engine',
    title: 'Design a Web Search Engine',
    description: 'Design a search engine that crawls the web, indexes pages, and serves search results ranked by relevance. Focus on the core search infrastructure.',
    requirements: [
      'Web crawler that discovers and indexes pages',
      'Inverted index for fast full-text search',
      'PageRank or similar relevance ranking',
      'Autocomplete / query suggestions',
      'Handle 10K queries per second',
      'Results returned in < 200ms',
    ],
    expectedComponents: ['client', 'cdn', 'load_balancer', 'api_gateway', 'app_server', 'database', 'search', 'storage', 'message_queue', 'cache'],
    difficulty: 'hard',
    applicableDomains: ['backend', 'data-science'],
    hints: [
      'How would you build and maintain the inverted index?',
      'Consider sharding the index across machines.',
      'Think about how the crawler avoids visiting the same page twice.',
    ],
    expectedTimeMinutes: 25,
    tags: ['search', 'indexing', 'crawling', 'ranking'],
  },
]

/**
 * Select a design problem based on domain, experience, and previously solved IDs.
 */
export function selectDesignProblem(
  domain: string,
  experience: string,
  solvedIds: string[] = []
): DesignProblem | null {
  // Map experience to difficulty
  const difficultyMap: Record<string, DesignProblem['difficulty'][]> = {
    '0-2': ['easy', 'medium'],
    '3-6': ['medium', 'hard'],
    '7+': ['medium', 'hard'],
  }
  const targetDifficulties = difficultyMap[experience] || ['easy', 'medium']

  // Filter by domain and difficulty, excluding solved
  const candidates = DESIGN_PROBLEMS.filter(
    (p) =>
      targetDifficulties.includes(p.difficulty) &&
      p.applicableDomains.includes(domain) &&
      !solvedIds.includes(p.id)
  )

  if (candidates.length === 0) {
    // Fallback: any unsolved problem matching difficulty
    const fallback = DESIGN_PROBLEMS.filter(
      (p) => targetDifficulties.includes(p.difficulty) && !solvedIds.includes(p.id)
    )
    if (fallback.length === 0) return null
    return fallback[Math.floor(Math.random() * fallback.length)]
  }

  return candidates[Math.floor(Math.random() * candidates.length)]
}
