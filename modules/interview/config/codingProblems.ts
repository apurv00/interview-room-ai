import type { CodeLanguage } from '@shared/types'

export interface CodingProblem {
  id: string
  title: string
  description: string
  examples: Array<{ input: string; output: string; explanation?: string }>
  constraints: string[]
  difficulty: 'easy' | 'medium' | 'hard'
  applicableDomains: string[]
  hints: string[]
  starterCode: Partial<Record<CodeLanguage, string>>
  expectedTimeMinutes: number
  tags: string[]
}

export const CODING_PROBLEMS: CodingProblem[] = [
  // ─── EASY ─────────────────────────────────────────────────────────────────

  {
    id: 'two-sum',
    title: 'Two Sum',
    description: 'Given an array of integers `nums` and an integer `target`, return the indices of the two numbers that add up to `target`. You may assume each input has exactly one solution, and you may not use the same element twice.',
    examples: [
      { input: 'nums = [2,7,11,15], target = 9', output: '[0,1]', explanation: 'Because nums[0] + nums[1] == 9' },
      { input: 'nums = [3,2,4], target = 6', output: '[1,2]' },
    ],
    constraints: ['2 <= nums.length <= 10^4', '-10^9 <= nums[i] <= 10^9', 'Only one valid answer exists'],
    difficulty: 'easy',
    applicableDomains: ['backend', 'frontend', 'data-science', 'sdet'],
    hints: ['Think about using a hash map to store seen values.', 'For each number, check if target - num exists in the map.'],
    starterCode: {
      python: 'def two_sum(nums: list[int], target: int) -> list[int]:\n    pass',
      javascript: 'function twoSum(nums, target) {\n  \n}',
      typescript: 'function twoSum(nums: number[], target: number): number[] {\n  \n}',
    },
    expectedTimeMinutes: 10,
    tags: ['arrays', 'hash-map'],
  },
  {
    id: 'valid-parentheses',
    title: 'Valid Parentheses',
    description: 'Given a string `s` containing just the characters `(`, `)`, `{`, `}`, `[` and `]`, determine if the input string is valid. A string is valid if: open brackets are closed by the same type, and open brackets are closed in the correct order.',
    examples: [
      { input: 's = "()"', output: 'true' },
      { input: 's = "()[]{}"', output: 'true' },
      { input: 's = "(]"', output: 'false' },
    ],
    constraints: ['1 <= s.length <= 10^4', 's consists of parentheses only'],
    difficulty: 'easy',
    applicableDomains: ['backend', 'frontend', 'sdet'],
    hints: ['Use a stack data structure.', 'Push opening brackets, pop and compare for closing brackets.'],
    starterCode: {
      python: 'def is_valid(s: str) -> bool:\n    pass',
      javascript: 'function isValid(s) {\n  \n}',
    },
    expectedTimeMinutes: 10,
    tags: ['stack', 'strings'],
  },
  {
    id: 'reverse-linked-list',
    title: 'Reverse Linked List',
    description: 'Given the head of a singly linked list, reverse the list, and return the reversed list.',
    examples: [
      { input: 'head = [1,2,3,4,5]', output: '[5,4,3,2,1]' },
      { input: 'head = [1,2]', output: '[2,1]' },
    ],
    constraints: ['0 <= number of nodes <= 5000', '-5000 <= Node.val <= 5000'],
    difficulty: 'easy',
    applicableDomains: ['backend', 'frontend', 'sdet'],
    hints: ['Use three pointers: prev, current, next.', 'Iterate and reverse the links one by one.'],
    starterCode: {
      python: 'def reverse_list(head):\n    pass',
      javascript: 'function reverseList(head) {\n  \n}',
    },
    expectedTimeMinutes: 10,
    tags: ['linked-list'],
  },
  {
    id: 'max-profit',
    title: 'Best Time to Buy and Sell Stock',
    description: 'Given an array `prices` where `prices[i]` is the price of a stock on the i-th day, find the maximum profit from one transaction (buy then sell). If no profit is possible, return 0.',
    examples: [
      { input: 'prices = [7,1,5,3,6,4]', output: '5', explanation: 'Buy on day 2 (price = 1) and sell on day 5 (price = 6)' },
      { input: 'prices = [7,6,4,3,1]', output: '0' },
    ],
    constraints: ['1 <= prices.length <= 10^5', '0 <= prices[i] <= 10^4'],
    difficulty: 'easy',
    applicableDomains: ['backend', 'frontend', 'data-science'],
    hints: ['Track the minimum price seen so far.', 'At each step, check if selling now would give max profit.'],
    starterCode: {
      python: 'def max_profit(prices: list[int]) -> int:\n    pass',
      javascript: 'function maxProfit(prices) {\n  \n}',
    },
    expectedTimeMinutes: 10,
    tags: ['arrays', 'greedy'],
  },
  {
    id: 'merge-sorted-arrays',
    title: 'Merge Two Sorted Arrays',
    description: 'Given two sorted integer arrays `nums1` and `nums2`, merge them into a single sorted array. Return the merged result.',
    examples: [
      { input: 'nums1 = [1,2,4], nums2 = [1,3,5]', output: '[1,1,2,3,4,5]' },
    ],
    constraints: ['0 <= nums1.length, nums2.length <= 200'],
    difficulty: 'easy',
    applicableDomains: ['backend', 'frontend', 'data-science', 'sdet'],
    hints: ['Use two pointers, one for each array.', 'Compare elements and pick the smaller one.'],
    starterCode: {
      python: 'def merge(nums1: list[int], nums2: list[int]) -> list[int]:\n    pass',
      javascript: 'function merge(nums1, nums2) {\n  \n}',
    },
    expectedTimeMinutes: 8,
    tags: ['arrays', 'two-pointers'],
  },

  // ─── MEDIUM ───────────────────────────────────────────────────────────────

  {
    id: 'group-anagrams',
    title: 'Group Anagrams',
    description: 'Given an array of strings `strs`, group the anagrams together. You can return the answer in any order. An anagram is a word formed by rearranging the letters of another word.',
    examples: [
      { input: 'strs = ["eat","tea","tan","ate","nat","bat"]', output: '[["bat"],["nat","tan"],["ate","eat","tea"]]' },
    ],
    constraints: ['1 <= strs.length <= 10^4', '0 <= strs[i].length <= 100'],
    difficulty: 'medium',
    applicableDomains: ['backend', 'frontend', 'data-science'],
    hints: ['Anagrams have the same sorted characters.', 'Use sorted string as a hash map key.'],
    starterCode: {
      python: 'def group_anagrams(strs: list[str]) -> list[list[str]]:\n    pass',
      javascript: 'function groupAnagrams(strs) {\n  \n}',
    },
    expectedTimeMinutes: 15,
    tags: ['hash-map', 'strings', 'sorting'],
  },
  {
    id: 'lru-cache',
    title: 'LRU Cache',
    description: 'Design a data structure that follows the Least Recently Used (LRU) cache eviction policy. Implement `get(key)` and `put(key, value)` with O(1) average time complexity.',
    examples: [
      { input: 'LRUCache(2), put(1,1), put(2,2), get(1), put(3,3), get(2)', output: '1, -1 (evicted key 2)' },
    ],
    constraints: ['1 <= capacity <= 3000', '0 <= key <= 10^4'],
    difficulty: 'medium',
    applicableDomains: ['backend', 'frontend'],
    hints: ['Use a hash map + doubly linked list.', 'Hash map gives O(1) lookup, linked list gives O(1) insertion/removal.'],
    starterCode: {
      python: 'class LRUCache:\n    def __init__(self, capacity: int):\n        pass\n\n    def get(self, key: int) -> int:\n        pass\n\n    def put(self, key: int, value: int) -> None:\n        pass',
      javascript: 'class LRUCache {\n  constructor(capacity) {\n    \n  }\n  get(key) {\n    \n  }\n  put(key, value) {\n    \n  }\n}',
    },
    expectedTimeMinutes: 20,
    tags: ['design', 'hash-map', 'linked-list'],
  },
  {
    id: 'binary-tree-level-order',
    title: 'Binary Tree Level Order Traversal',
    description: 'Given the root of a binary tree, return the level order traversal of its nodes\' values (i.e., from left to right, level by level).',
    examples: [
      { input: 'root = [3,9,20,null,null,15,7]', output: '[[3],[9,20],[15,7]]' },
    ],
    constraints: ['0 <= number of nodes <= 2000'],
    difficulty: 'medium',
    applicableDomains: ['backend', 'frontend', 'data-science'],
    hints: ['Use a queue (BFS approach).', 'Process all nodes at the current level before moving to the next.'],
    starterCode: {
      python: 'def level_order(root) -> list[list[int]]:\n    pass',
      javascript: 'function levelOrder(root) {\n  \n}',
    },
    expectedTimeMinutes: 15,
    tags: ['trees', 'bfs'],
  },
  {
    id: 'max-subarray',
    title: 'Maximum Subarray',
    description: 'Given an integer array `nums`, find the subarray with the largest sum, and return its sum.',
    examples: [
      { input: 'nums = [-2,1,-3,4,-1,2,1,-5,4]', output: '6', explanation: 'The subarray [4,-1,2,1] has the largest sum 6.' },
    ],
    constraints: ['1 <= nums.length <= 10^5', '-10^4 <= nums[i] <= 10^4'],
    difficulty: 'medium',
    applicableDomains: ['backend', 'frontend', 'data-science'],
    hints: ['Use Kadane\'s algorithm.', 'Track current sum and max sum. Reset current sum when it goes negative.'],
    starterCode: {
      python: 'def max_sub_array(nums: list[int]) -> int:\n    pass',
      javascript: 'function maxSubArray(nums) {\n  \n}',
    },
    expectedTimeMinutes: 12,
    tags: ['arrays', 'dynamic-programming', 'greedy'],
  },
  {
    id: 'word-search',
    title: 'Word Search',
    description: 'Given an m x n grid of characters `board` and a string `word`, return true if `word` exists in the grid. The word can be constructed from letters of sequentially adjacent cells (horizontal or vertical).',
    examples: [
      { input: 'board = [["A","B"],["C","D"]], word = "ABDC"', output: 'true' },
    ],
    constraints: ['1 <= m, n <= 6', '1 <= word.length <= 15'],
    difficulty: 'medium',
    applicableDomains: ['backend', 'data-science'],
    hints: ['Use DFS with backtracking.', 'Mark visited cells to avoid reuse, then unmark when backtracking.'],
    starterCode: {
      python: 'def exist(board: list[list[str]], word: str) -> bool:\n    pass',
      javascript: 'function exist(board, word) {\n  \n}',
    },
    expectedTimeMinutes: 20,
    tags: ['matrix', 'dfs', 'backtracking'],
  },

  // ─── HARD ─────────────────────────────────────────────────────────────────

  {
    id: 'merge-k-sorted',
    title: 'Merge K Sorted Lists',
    description: 'Given an array of `k` linked lists, each sorted in ascending order, merge all the linked lists into one sorted linked list and return it.',
    examples: [
      { input: 'lists = [[1,4,5],[1,3,4],[2,6]]', output: '[1,1,2,3,4,4,5,6]' },
    ],
    constraints: ['k == lists.length', '0 <= k <= 10^4', '0 <= lists[i].length <= 500'],
    difficulty: 'hard',
    applicableDomains: ['backend', 'data-science'],
    hints: ['Use a min-heap (priority queue).', 'Alternatively, merge lists in pairs (divide and conquer).'],
    starterCode: {
      python: 'def merge_k_lists(lists):\n    pass',
      javascript: 'function mergeKLists(lists) {\n  \n}',
    },
    expectedTimeMinutes: 25,
    tags: ['heap', 'linked-list', 'divide-and-conquer'],
  },
  {
    id: 'median-sorted-arrays',
    title: 'Median of Two Sorted Arrays',
    description: 'Given two sorted arrays `nums1` and `nums2`, return the median of the two sorted arrays. The overall run time complexity should be O(log(m+n)).',
    examples: [
      { input: 'nums1 = [1,3], nums2 = [2]', output: '2.0' },
      { input: 'nums1 = [1,2], nums2 = [3,4]', output: '2.5' },
    ],
    constraints: ['0 <= nums1.length, nums2.length <= 1000'],
    difficulty: 'hard',
    applicableDomains: ['backend', 'data-science'],
    hints: ['Use binary search on the shorter array.', 'Find the correct partition point where left elements are all smaller than right elements.'],
    starterCode: {
      python: 'def find_median(nums1: list[int], nums2: list[int]) -> float:\n    pass',
      javascript: 'function findMedianSortedArrays(nums1, nums2) {\n  \n}',
    },
    expectedTimeMinutes: 30,
    tags: ['binary-search', 'arrays'],
  },
  {
    id: 'serialize-tree',
    title: 'Serialize and Deserialize Binary Tree',
    description: 'Design an algorithm to serialize a binary tree to a string and deserialize that string back to the original tree structure.',
    examples: [
      { input: 'root = [1,2,3,null,null,4,5]', output: '"1,2,null,null,3,4,null,null,5,null,null"' },
    ],
    constraints: ['0 <= number of nodes <= 10^4'],
    difficulty: 'hard',
    applicableDomains: ['backend', 'frontend'],
    hints: ['Use pre-order traversal with null markers.', 'Use a queue/index pointer for deserialization.'],
    starterCode: {
      python: 'class Codec:\n    def serialize(self, root) -> str:\n        pass\n\n    def deserialize(self, data: str):\n        pass',
      javascript: 'function serialize(root) {\n  \n}\n\nfunction deserialize(data) {\n  \n}',
    },
    expectedTimeMinutes: 25,
    tags: ['trees', 'design', 'dfs'],
  },
]

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function getProblemsByDifficulty(difficulty: CodingProblem['difficulty'], domain?: string): CodingProblem[] {
  return CODING_PROBLEMS.filter((p) =>
    p.difficulty === difficulty &&
    (!domain || p.applicableDomains.includes(domain))
  )
}

export function getProblemById(id: string): CodingProblem | undefined {
  return CODING_PROBLEMS.find((p) => p.id === id)
}

export function selectProblem(domain: string, experience: string, usedIds: string[] = []): CodingProblem | null {
  const difficulty = experience === '7+' ? 'medium' : experience === '3-6' ? 'medium' : 'easy'
  const candidates = CODING_PROBLEMS.filter(
    (p) => p.difficulty === difficulty &&
    p.applicableDomains.includes(domain) &&
    !usedIds.includes(p.id)
  )
  if (candidates.length === 0) return null
  return candidates[Math.floor(Math.random() * candidates.length)]
}
