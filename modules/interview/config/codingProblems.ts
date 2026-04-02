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
  {
    id: 'contains-duplicate',
    title: 'Contains Duplicate',
    description: 'Given an integer array `nums`, return `true` if any value appears at least twice in the array, and return `false` if every element is distinct.',
    examples: [
      { input: 'nums = [1,2,3,1]', output: 'true' },
      { input: 'nums = [1,2,3,4]', output: 'false' },
    ],
    constraints: ['1 <= nums.length <= 10^5', '-10^9 <= nums[i] <= 10^9'],
    difficulty: 'easy',
    applicableDomains: ['backend', 'frontend', 'data-science', 'sdet'],
    hints: ['Use a Set to track seen values.', 'If a value is already in the set, return true.'],
    starterCode: {
      python: 'def contains_duplicate(nums: list[int]) -> bool:\n    pass',
      javascript: 'function containsDuplicate(nums) {\n  \n}',
    },
    expectedTimeMinutes: 5,
    tags: ['arrays', 'hash-map'],
  },
  {
    id: 'valid-anagram',
    title: 'Valid Anagram',
    description: 'Given two strings `s` and `t`, return `true` if `t` is an anagram of `s`, and `false` otherwise. An anagram uses the same characters the same number of times.',
    examples: [
      { input: 's = "anagram", t = "nagaram"', output: 'true' },
      { input: 's = "rat", t = "car"', output: 'false' },
    ],
    constraints: ['1 <= s.length, t.length <= 5 * 10^4', 's and t consist of lowercase English letters'],
    difficulty: 'easy',
    applicableDomains: ['backend', 'frontend', 'data-science', 'sdet'],
    hints: ['Count character frequencies.', 'Compare frequency maps of both strings.'],
    starterCode: {
      python: 'def is_anagram(s: str, t: str) -> bool:\n    pass',
      javascript: 'function isAnagram(s, t) {\n  \n}',
    },
    expectedTimeMinutes: 8,
    tags: ['strings', 'sorting', 'hash-map'],
  },
  {
    id: 'climbing-stairs',
    title: 'Climbing Stairs',
    description: 'You are climbing a staircase. It takes `n` steps to reach the top. Each time you can either climb 1 or 2 steps. In how many distinct ways can you climb to the top?',
    examples: [
      { input: 'n = 2', output: '2', explanation: '1+1 or 2' },
      { input: 'n = 3', output: '3', explanation: '1+1+1, 1+2, or 2+1' },
    ],
    constraints: ['1 <= n <= 45'],
    difficulty: 'easy',
    applicableDomains: ['backend', 'frontend', 'data-science'],
    hints: ['This is a Fibonacci-like sequence.', 'ways(n) = ways(n-1) + ways(n-2)'],
    starterCode: {
      python: 'def climb_stairs(n: int) -> int:\n    pass',
      javascript: 'function climbStairs(n) {\n  \n}',
    },
    expectedTimeMinutes: 8,
    tags: ['dynamic-programming', 'math'],
  },
  {
    id: 'maximum-depth-binary-tree',
    title: 'Maximum Depth of Binary Tree',
    description: 'Given the `root` of a binary tree, return its maximum depth. Maximum depth is the number of nodes along the longest path from root to the farthest leaf node.',
    examples: [
      { input: 'root = [3,9,20,null,null,15,7]', output: '3' },
      { input: 'root = [1,null,2]', output: '2' },
    ],
    constraints: ['0 <= number of nodes <= 10^4'],
    difficulty: 'easy',
    applicableDomains: ['backend', 'frontend', 'data-science'],
    hints: ['Use recursion: depth = 1 + max(left depth, right depth).', 'Base case: null node returns 0.'],
    starterCode: {
      python: 'def max_depth(root) -> int:\n    pass',
      javascript: 'function maxDepth(root) {\n  \n}',
    },
    expectedTimeMinutes: 8,
    tags: ['trees', 'dfs', 'recursion'],
  },
  {
    id: 'single-number',
    title: 'Single Number',
    description: 'Given a non-empty array of integers `nums`, every element appears twice except for one. Find that single one. You must implement a solution with O(1) extra space.',
    examples: [
      { input: 'nums = [2,2,1]', output: '1' },
      { input: 'nums = [4,1,2,1,2]', output: '4' },
    ],
    constraints: ['1 <= nums.length <= 3 * 10^4', 'Each element appears twice except one'],
    difficulty: 'easy',
    applicableDomains: ['backend', 'frontend', 'sdet'],
    hints: ['XOR of a number with itself is 0.', 'XOR all elements together — duplicates cancel out.'],
    starterCode: {
      python: 'def single_number(nums: list[int]) -> int:\n    pass',
      javascript: 'function singleNumber(nums) {\n  \n}',
    },
    expectedTimeMinutes: 8,
    tags: ['bit-manipulation', 'arrays'],
  },
  {
    id: 'linked-list-cycle',
    title: 'Linked List Cycle',
    description: 'Given `head`, the head of a linked list, determine if the linked list has a cycle in it. Return `true` if there is a cycle, `false` otherwise.',
    examples: [
      { input: 'head = [3,2,0,-4], pos = 1', output: 'true', explanation: 'Tail connects to node at index 1' },
      { input: 'head = [1], pos = -1', output: 'false' },
    ],
    constraints: ['0 <= number of nodes <= 10^4'],
    difficulty: 'easy',
    applicableDomains: ['backend', 'frontend', 'sdet'],
    hints: ['Use Floyd\'s cycle detection (slow & fast pointers).', 'If fast meets slow, there is a cycle.'],
    starterCode: {
      python: 'def has_cycle(head) -> bool:\n    pass',
      javascript: 'function hasCycle(head) {\n  \n}',
    },
    expectedTimeMinutes: 10,
    tags: ['linked-list', 'two-pointers'],
  },
  {
    id: 'palindrome-string',
    title: 'Valid Palindrome',
    description: 'Given a string `s`, return `true` if it is a palindrome after converting to lowercase and removing non-alphanumeric characters.',
    examples: [
      { input: 's = "A man, a plan, a canal: Panama"', output: 'true' },
      { input: 's = "race a car"', output: 'false' },
    ],
    constraints: ['1 <= s.length <= 2 * 10^5'],
    difficulty: 'easy',
    applicableDomains: ['backend', 'frontend', 'sdet'],
    hints: ['Clean the string first, then compare.', 'Or use two pointers from both ends.'],
    starterCode: {
      python: 'def is_palindrome(s: str) -> bool:\n    pass',
      javascript: 'function isPalindrome(s) {\n  \n}',
    },
    expectedTimeMinutes: 8,
    tags: ['strings', 'two-pointers'],
  },
  {
    id: 'intersection-two-arrays',
    title: 'Intersection of Two Arrays II',
    description: 'Given two integer arrays `nums1` and `nums2`, return an array of their intersection. Each element must appear as many times as it shows in both arrays.',
    examples: [
      { input: 'nums1 = [1,2,2,1], nums2 = [2,2]', output: '[2,2]' },
      { input: 'nums1 = [4,9,5], nums2 = [9,4,9,8,4]', output: '[4,9]' },
    ],
    constraints: ['1 <= nums1.length, nums2.length <= 1000'],
    difficulty: 'easy',
    applicableDomains: ['backend', 'frontend', 'data-science', 'sdet'],
    hints: ['Use a frequency map for one array.', 'Iterate the other and decrement counts.'],
    starterCode: {
      python: 'def intersect(nums1: list[int], nums2: list[int]) -> list[int]:\n    pass',
      javascript: 'function intersect(nums1, nums2) {\n  \n}',
    },
    expectedTimeMinutes: 8,
    tags: ['arrays', 'hash-map', 'sorting'],
  },
  {
    id: 'move-zeroes',
    title: 'Move Zeroes',
    description: 'Given an integer array `nums`, move all 0s to the end while maintaining the relative order of the non-zero elements. Do this in-place.',
    examples: [
      { input: 'nums = [0,1,0,3,12]', output: '[1,3,12,0,0]' },
      { input: 'nums = [0]', output: '[0]' },
    ],
    constraints: ['1 <= nums.length <= 10^4'],
    difficulty: 'easy',
    applicableDomains: ['backend', 'frontend', 'sdet'],
    hints: ['Use a write pointer for non-zero elements.', 'Fill remaining positions with zeros.'],
    starterCode: {
      python: 'def move_zeroes(nums: list[int]) -> None:\n    pass',
      javascript: 'function moveZeroes(nums) {\n  \n}',
    },
    expectedTimeMinutes: 8,
    tags: ['arrays', 'two-pointers'],
  },
  {
    id: 'fizzbuzz',
    title: 'FizzBuzz',
    description: 'Given an integer `n`, return a string array where: for multiples of 3 output "Fizz", for multiples of 5 output "Buzz", for multiples of both output "FizzBuzz", otherwise output the number.',
    examples: [
      { input: 'n = 5', output: '["1","2","Fizz","4","Buzz"]' },
      { input: 'n = 15', output: '["1","2","Fizz","4","Buzz","Fizz","7","8","Fizz","Buzz","11","Fizz","13","14","FizzBuzz"]' },
    ],
    constraints: ['1 <= n <= 10^4'],
    difficulty: 'easy',
    applicableDomains: ['backend', 'frontend', 'data-science', 'sdet'],
    hints: ['Check divisibility by 15 first, then 3, then 5.', 'Build result string before checking number.'],
    starterCode: {
      python: 'def fizz_buzz(n: int) -> list[str]:\n    pass',
      javascript: 'function fizzBuzz(n) {\n  \n}',
    },
    expectedTimeMinutes: 5,
    tags: ['math', 'strings'],
  },
  {
    id: 'debounce-function',
    title: 'Implement Debounce',
    description: 'Implement a `debounce` function that delays invoking `fn` until after `delay` milliseconds have elapsed since the last time the debounced function was invoked. It should return a new function.',
    examples: [
      { input: 'const debouncedLog = debounce(console.log, 300)', output: 'Only executes after 300ms of inactivity' },
    ],
    constraints: ['delay >= 0', 'fn is a valid function'],
    difficulty: 'easy',
    applicableDomains: ['frontend', 'backend'],
    hints: ['Use setTimeout and clearTimeout.', 'Store the timer ID in a closure.'],
    starterCode: {
      python: 'import threading\n\ndef debounce(fn, delay_ms):\n    pass',
      javascript: 'function debounce(fn, delay) {\n  \n}',
      typescript: 'function debounce<T extends (...args: any[]) => any>(fn: T, delay: number): (...args: Parameters<T>) => void {\n  \n}',
    },
    expectedTimeMinutes: 10,
    tags: ['frontend-specific', 'closures'],
  },
  {
    id: 'flatten-array',
    title: 'Flatten Nested Array',
    description: 'Given a nested array of integers, flatten it into a single-level array. The input may be nested to any depth.',
    examples: [
      { input: 'arr = [1,[2,[3,[4]],5]]', output: '[1,2,3,4,5]' },
      { input: 'arr = [[1,2],[3,[4,5]]]', output: '[1,2,3,4,5]' },
    ],
    constraints: ['0 <= arr.length <= 1000', 'Nesting depth <= 100'],
    difficulty: 'easy',
    applicableDomains: ['backend', 'frontend', 'data-science', 'sdet'],
    hints: ['Use recursion: if element is array, flatten it.', 'Or use a stack-based iterative approach.'],
    starterCode: {
      python: 'def flatten(arr) -> list[int]:\n    pass',
      javascript: 'function flatten(arr) {\n  \n}',
    },
    expectedTimeMinutes: 8,
    tags: ['recursion', 'arrays'],
  },
  {
    id: 'count-vowels',
    title: 'Count Vowels',
    description: 'Given a string `s`, return the number of vowels (a, e, i, o, u) in the string. Count both uppercase and lowercase vowels.',
    examples: [
      { input: 's = "Hello World"', output: '3' },
      { input: 's = "AEIOU"', output: '5' },
    ],
    constraints: ['0 <= s.length <= 10^4'],
    difficulty: 'easy',
    applicableDomains: ['backend', 'frontend', 'data-science', 'sdet'],
    hints: ['Use a set of vowels for O(1) lookup.', 'Iterate and count matches.'],
    starterCode: {
      python: 'def count_vowels(s: str) -> int:\n    pass',
      javascript: 'function countVowels(s) {\n  \n}',
    },
    expectedTimeMinutes: 5,
    tags: ['strings'],
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
  {
    id: 'longest-substring-no-repeat',
    title: 'Longest Substring Without Repeating Characters',
    description: 'Given a string `s`, find the length of the longest substring without repeating characters.',
    examples: [
      { input: 's = "abcabcbb"', output: '3', explanation: '"abc"' },
      { input: 's = "bbbbb"', output: '1' },
    ],
    constraints: ['0 <= s.length <= 5 * 10^4'],
    difficulty: 'medium',
    applicableDomains: ['backend', 'frontend', 'data-science', 'sdet'],
    hints: ['Use a sliding window with a Set.', 'Expand right, shrink left when duplicate found.'],
    starterCode: {
      python: 'def length_of_longest_substring(s: str) -> int:\n    pass',
      javascript: 'function lengthOfLongestSubstring(s) {\n  \n}',
    },
    expectedTimeMinutes: 15,
    tags: ['sliding-window', 'hash-map', 'strings'],
  },
  {
    id: 'three-sum',
    title: 'Three Sum',
    description: 'Given an integer array `nums`, return all the triplets `[nums[i], nums[j], nums[k]]` such that `i != j != k` and `nums[i] + nums[j] + nums[k] == 0`. No duplicate triplets.',
    examples: [
      { input: 'nums = [-1,0,1,2,-1,-4]', output: '[[-1,-1,2],[-1,0,1]]' },
    ],
    constraints: ['3 <= nums.length <= 3000', '-10^5 <= nums[i] <= 10^5'],
    difficulty: 'medium',
    applicableDomains: ['backend', 'frontend', 'data-science'],
    hints: ['Sort first, then use two pointers for each element.', 'Skip duplicates to avoid repeated triplets.'],
    starterCode: {
      python: 'def three_sum(nums: list[int]) -> list[list[int]]:\n    pass',
      javascript: 'function threeSum(nums) {\n  \n}',
    },
    expectedTimeMinutes: 20,
    tags: ['arrays', 'two-pointers', 'sorting'],
  },
  {
    id: 'number-of-islands',
    title: 'Number of Islands',
    description: 'Given an m x n 2D grid of "1"s (land) and "0"s (water), count the number of islands. An island is surrounded by water and is formed by connecting adjacent lands horizontally or vertically.',
    examples: [
      { input: 'grid = [["1","1","0"],["1","1","0"],["0","0","1"]]', output: '2' },
    ],
    constraints: ['1 <= m, n <= 300'],
    difficulty: 'medium',
    applicableDomains: ['backend', 'frontend', 'data-science'],
    hints: ['Use DFS/BFS to flood-fill each island.', 'Mark visited cells to avoid counting twice.'],
    starterCode: {
      python: 'def num_islands(grid: list[list[str]]) -> int:\n    pass',
      javascript: 'function numIslands(grid) {\n  \n}',
    },
    expectedTimeMinutes: 15,
    tags: ['matrix', 'dfs', 'bfs'],
  },
  {
    id: 'coin-change',
    title: 'Coin Change',
    description: 'Given an array `coins` of coin denominations and an integer `amount`, return the fewest number of coins needed to make up that amount. If it cannot be made, return -1.',
    examples: [
      { input: 'coins = [1,5,10,25], amount = 30', output: '2', explanation: '25 + 5' },
      { input: 'coins = [2], amount = 3', output: '-1' },
    ],
    constraints: ['1 <= coins.length <= 12', '0 <= amount <= 10^4'],
    difficulty: 'medium',
    applicableDomains: ['backend', 'frontend', 'data-science'],
    hints: ['Use bottom-up DP.', 'dp[i] = min coins needed for amount i.'],
    starterCode: {
      python: 'def coin_change(coins: list[int], amount: int) -> int:\n    pass',
      javascript: 'function coinChange(coins, amount) {\n  \n}',
    },
    expectedTimeMinutes: 15,
    tags: ['dynamic-programming'],
  },
  {
    id: 'validate-bst',
    title: 'Validate Binary Search Tree',
    description: 'Given the `root` of a binary tree, determine if it is a valid BST. A valid BST has: left subtree values < node value, right subtree values > node value, and both subtrees are valid BSTs.',
    examples: [
      { input: 'root = [2,1,3]', output: 'true' },
      { input: 'root = [5,1,4,null,null,3,6]', output: 'false' },
    ],
    constraints: ['1 <= number of nodes <= 10^4'],
    difficulty: 'medium',
    applicableDomains: ['backend', 'frontend', 'data-science'],
    hints: ['Use recursion with min/max bounds.', 'Pass valid range down to each node.'],
    starterCode: {
      python: 'def is_valid_bst(root) -> bool:\n    pass',
      javascript: 'function isValidBST(root) {\n  \n}',
    },
    expectedTimeMinutes: 15,
    tags: ['trees', 'dfs'],
  },
  {
    id: 'product-except-self',
    title: 'Product of Array Except Self',
    description: 'Given an integer array `nums`, return an array `answer` where `answer[i]` is the product of all elements except `nums[i]`. Must run in O(n) without using division.',
    examples: [
      { input: 'nums = [1,2,3,4]', output: '[24,12,8,6]' },
    ],
    constraints: ['2 <= nums.length <= 10^5'],
    difficulty: 'medium',
    applicableDomains: ['backend', 'frontend', 'data-science'],
    hints: ['Use prefix and suffix products.', 'Two passes: left-to-right then right-to-left.'],
    starterCode: {
      python: 'def product_except_self(nums: list[int]) -> list[int]:\n    pass',
      javascript: 'function productExceptSelf(nums) {\n  \n}',
    },
    expectedTimeMinutes: 15,
    tags: ['arrays', 'prefix-sum'],
  },
  {
    id: 'merge-intervals',
    title: 'Merge Intervals',
    description: 'Given an array of `intervals` where `intervals[i] = [starti, endi]`, merge all overlapping intervals and return the non-overlapping intervals.',
    examples: [
      { input: 'intervals = [[1,3],[2,6],[8,10],[15,18]]', output: '[[1,6],[8,10],[15,18]]' },
    ],
    constraints: ['1 <= intervals.length <= 10^4'],
    difficulty: 'medium',
    applicableDomains: ['backend', 'frontend', 'data-science', 'sdet'],
    hints: ['Sort by start time first.', 'Compare each interval\'s start with previous end.'],
    starterCode: {
      python: 'def merge(intervals: list[list[int]]) -> list[list[int]]:\n    pass',
      javascript: 'function merge(intervals) {\n  \n}',
    },
    expectedTimeMinutes: 15,
    tags: ['intervals', 'sorting'],
  },
  {
    id: 'rotate-image',
    title: 'Rotate Image',
    description: 'Given an n x n 2D `matrix` representing an image, rotate the image by 90 degrees clockwise. You must rotate it in-place.',
    examples: [
      { input: 'matrix = [[1,2,3],[4,5,6],[7,8,9]]', output: '[[7,4,1],[8,5,2],[9,6,3]]' },
    ],
    constraints: ['1 <= n <= 20'],
    difficulty: 'medium',
    applicableDomains: ['backend', 'frontend', 'data-science'],
    hints: ['Transpose the matrix, then reverse each row.', 'Or rotate layer by layer from outside in.'],
    starterCode: {
      python: 'def rotate(matrix: list[list[int]]) -> None:\n    pass',
      javascript: 'function rotate(matrix) {\n  \n}',
    },
    expectedTimeMinutes: 15,
    tags: ['matrix'],
  },
  {
    id: 'clone-graph',
    title: 'Clone Graph',
    description: 'Given a reference of a node in a connected undirected graph, return a deep copy (clone) of the graph. Each node has a value and a list of neighbors.',
    examples: [
      { input: 'adjList = [[2,4],[1,3],[2,4],[1,3]]', output: '[[2,4],[1,3],[2,4],[1,3]]' },
    ],
    constraints: ['0 <= number of nodes <= 100'],
    difficulty: 'medium',
    applicableDomains: ['backend', 'data-science'],
    hints: ['Use a hash map to track cloned nodes.', 'DFS or BFS to visit all nodes.'],
    starterCode: {
      python: 'def clone_graph(node):\n    pass',
      javascript: 'function cloneGraph(node) {\n  \n}',
    },
    expectedTimeMinutes: 15,
    tags: ['graph', 'dfs', 'hash-map'],
  },
  {
    id: 'course-schedule',
    title: 'Course Schedule',
    description: 'There are `numCourses` courses (0 to numCourses-1). Given prerequisites as pairs `[a, b]` (to take a, you must first take b), determine if you can finish all courses.',
    examples: [
      { input: 'numCourses = 2, prerequisites = [[1,0]]', output: 'true' },
      { input: 'numCourses = 2, prerequisites = [[1,0],[0,1]]', output: 'false', explanation: 'Circular dependency' },
    ],
    constraints: ['1 <= numCourses <= 2000'],
    difficulty: 'medium',
    applicableDomains: ['backend', 'data-science'],
    hints: ['Build an adjacency list and detect cycles.', 'Use topological sort or DFS with visited states.'],
    starterCode: {
      python: 'def can_finish(num_courses: int, prerequisites: list[list[int]]) -> bool:\n    pass',
      javascript: 'function canFinish(numCourses, prerequisites) {\n  \n}',
    },
    expectedTimeMinutes: 20,
    tags: ['graph', 'topological-sort'],
  },
  {
    id: 'implement-trie',
    title: 'Implement Trie (Prefix Tree)',
    description: 'Implement a Trie with `insert(word)`, `search(word)` (exact match), and `startsWith(prefix)` (prefix match) methods.',
    examples: [
      { input: 'insert("apple"), search("apple"), search("app"), startsWith("app")', output: 'true, false, true' },
    ],
    constraints: ['1 <= word.length, prefix.length <= 2000'],
    difficulty: 'medium',
    applicableDomains: ['backend', 'frontend'],
    hints: ['Each node has a map of children and an "end of word" flag.', 'Traverse character by character.'],
    starterCode: {
      python: 'class Trie:\n    def __init__(self):\n        pass\n\n    def insert(self, word: str) -> None:\n        pass\n\n    def search(self, word: str) -> bool:\n        pass\n\n    def starts_with(self, prefix: str) -> bool:\n        pass',
      javascript: 'class Trie {\n  constructor() {\n    \n  }\n  insert(word) {\n    \n  }\n  search(word) {\n    \n  }\n  startsWith(prefix) {\n    \n  }\n}',
    },
    expectedTimeMinutes: 20,
    tags: ['trie', 'design'],
  },
  {
    id: 'top-k-frequent',
    title: 'Top K Frequent Elements',
    description: 'Given an integer array `nums` and an integer `k`, return the `k` most frequent elements. You may return the answer in any order.',
    examples: [
      { input: 'nums = [1,1,1,2,2,3], k = 2', output: '[1,2]' },
    ],
    constraints: ['1 <= nums.length <= 10^5', '1 <= k <= number of unique elements'],
    difficulty: 'medium',
    applicableDomains: ['backend', 'frontend', 'data-science'],
    hints: ['Count frequencies with a hash map.', 'Use a min-heap of size k, or bucket sort by frequency.'],
    starterCode: {
      python: 'def top_k_frequent(nums: list[int], k: int) -> list[int]:\n    pass',
      javascript: 'function topKFrequent(nums, k) {\n  \n}',
    },
    expectedTimeMinutes: 15,
    tags: ['heap', 'hash-map'],
  },
  {
    id: 'decode-ways',
    title: 'Decode Ways',
    description: 'A message of digits can be decoded where "1" → "A", "2" → "B", ..., "26" → "Z". Given a string `s` of digits, return the number of ways to decode it.',
    examples: [
      { input: 's = "12"', output: '2', explanation: '"AB" (1,2) or "L" (12)' },
      { input: 's = "226"', output: '3' },
    ],
    constraints: ['1 <= s.length <= 100', 's contains only digits and may have leading zeros'],
    difficulty: 'medium',
    applicableDomains: ['backend', 'frontend'],
    hints: ['Use DP similar to climbing stairs.', 'Check 1-digit and 2-digit decodings at each position.'],
    starterCode: {
      python: 'def num_decodings(s: str) -> int:\n    pass',
      javascript: 'function numDecodings(s) {\n  \n}',
    },
    expectedTimeMinutes: 15,
    tags: ['dynamic-programming', 'strings'],
  },
  {
    id: 'event-emitter',
    title: 'Implement Event Emitter',
    description: 'Implement an EventEmitter class with methods: `on(event, callback)` to subscribe, `emit(event, ...args)` to trigger, and `off(event, callback)` to unsubscribe.',
    examples: [
      { input: 'emitter.on("data", cb); emitter.emit("data", 42)', output: 'cb called with 42' },
    ],
    constraints: ['Support multiple listeners per event', 'off should remove specific callback'],
    difficulty: 'medium',
    applicableDomains: ['frontend', 'backend'],
    hints: ['Use a Map of event name → Set of callbacks.', 'emit iterates and calls each callback.'],
    starterCode: {
      python: 'class EventEmitter:\n    def __init__(self):\n        pass\n\n    def on(self, event, callback):\n        pass\n\n    def emit(self, event, *args):\n        pass\n\n    def off(self, event, callback):\n        pass',
      javascript: 'class EventEmitter {\n  on(event, callback) {\n    \n  }\n  emit(event, ...args) {\n    \n  }\n  off(event, callback) {\n    \n  }\n}',
    },
    expectedTimeMinutes: 15,
    tags: ['frontend-specific', 'design'],
  },
  {
    id: 'promise-all',
    title: 'Implement Promise.all',
    description: 'Implement a function `promiseAll(promises)` that takes an array of promises and returns a promise that resolves with an array of results when all input promises resolve, or rejects if any promise rejects.',
    examples: [
      { input: 'promiseAll([Promise.resolve(1), Promise.resolve(2)])', output: '[1, 2]' },
    ],
    constraints: ['Maintain order of results matching input order', 'Reject immediately on first rejection'],
    difficulty: 'medium',
    applicableDomains: ['frontend', 'backend'],
    hints: ['Track resolved count and results array.', 'Resolve outer promise when count equals total.'],
    starterCode: {
      javascript: 'function promiseAll(promises) {\n  return new Promise((resolve, reject) => {\n    \n  })\n}',
      typescript: 'function promiseAll<T>(promises: Promise<T>[]): Promise<T[]> {\n  return new Promise((resolve, reject) => {\n    \n  })\n}',
    },
    expectedTimeMinutes: 15,
    tags: ['frontend-specific', 'async'],
  },
  {
    id: 'pandas-groupby',
    title: 'GroupBy Aggregation',
    description: 'Given a list of records (dicts with "category" and "value" keys), group by category and return the sum, count, and average for each category.',
    examples: [
      { input: 'records = [{"category":"A","value":10},{"category":"B","value":20},{"category":"A","value":30}]', output: '{"A":{"sum":40,"count":2,"avg":20},"B":{"sum":20,"count":1,"avg":20}}' },
    ],
    constraints: ['0 <= records.length <= 10^4'],
    difficulty: 'medium',
    applicableDomains: ['data-science', 'backend'],
    hints: ['Use a dictionary to accumulate per-category.', 'Track sum and count, compute avg at the end.'],
    starterCode: {
      python: 'def groupby_aggregate(records: list[dict]) -> dict:\n    pass',
      javascript: 'function groupByAggregate(records) {\n  \n}',
    },
    expectedTimeMinutes: 12,
    tags: ['data-science-specific', 'hash-map'],
  },
  {
    id: 'matrix-spiral',
    title: 'Spiral Matrix',
    description: 'Given an m x n `matrix`, return all elements in spiral order (clockwise from top-left).',
    examples: [
      { input: 'matrix = [[1,2,3],[4,5,6],[7,8,9]]', output: '[1,2,3,6,9,8,7,4,5]' },
    ],
    constraints: ['1 <= m, n <= 10'],
    difficulty: 'medium',
    applicableDomains: ['backend', 'frontend', 'data-science'],
    hints: ['Track boundaries: top, bottom, left, right.', 'Shrink boundaries after traversing each edge.'],
    starterCode: {
      python: 'def spiral_order(matrix: list[list[int]]) -> list[int]:\n    pass',
      javascript: 'function spiralOrder(matrix) {\n  \n}',
    },
    expectedTimeMinutes: 15,
    tags: ['matrix'],
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
  {
    id: 'minimum-window-substring',
    title: 'Minimum Window Substring',
    description: 'Given two strings `s` and `t`, return the minimum window substring of `s` such that every character in `t` (including duplicates) is included. If no such window exists, return "".',
    examples: [
      { input: 's = "ADOBECODEBANC", t = "ABC"', output: '"BANC"' },
      { input: 's = "a", t = "aa"', output: '""' },
    ],
    constraints: ['1 <= s.length, t.length <= 10^5'],
    difficulty: 'hard',
    applicableDomains: ['backend', 'data-science'],
    hints: ['Use sliding window with two pointers.', 'Track character counts needed vs. found.'],
    starterCode: {
      python: 'def min_window(s: str, t: str) -> str:\n    pass',
      javascript: 'function minWindow(s, t) {\n  \n}',
    },
    expectedTimeMinutes: 25,
    tags: ['sliding-window', 'hash-map', 'strings'],
  },
  {
    id: 'word-ladder',
    title: 'Word Ladder',
    description: 'Given `beginWord`, `endWord`, and a `wordList`, find the shortest transformation sequence length from beginWord to endWord, changing one letter at a time. Each intermediate word must be in wordList.',
    examples: [
      { input: 'beginWord = "hit", endWord = "cog", wordList = ["hot","dot","dog","lot","log","cog"]', output: '5', explanation: '"hit" → "hot" → "dot" → "dog" → "cog"' },
    ],
    constraints: ['1 <= wordList.length <= 5000', 'All words same length'],
    difficulty: 'hard',
    applicableDomains: ['backend', 'data-science'],
    hints: ['Use BFS — each word is a node, edges connect words differing by 1 char.', 'Pre-process word patterns for efficient neighbor lookup.'],
    starterCode: {
      python: 'def ladder_length(begin_word: str, end_word: str, word_list: list[str]) -> int:\n    pass',
      javascript: 'function ladderLength(beginWord, endWord, wordList) {\n  \n}',
    },
    expectedTimeMinutes: 25,
    tags: ['bfs', 'graph'],
  },
  {
    id: 'trapping-rain-water',
    title: 'Trapping Rain Water',
    description: 'Given `n` non-negative integers representing an elevation map where the width of each bar is 1, compute how much water it can trap after raining.',
    examples: [
      { input: 'height = [0,1,0,2,1,0,1,3,2,1,2,1]', output: '6' },
    ],
    constraints: ['n == height.length', '1 <= n <= 2 * 10^4', '0 <= height[i] <= 10^5'],
    difficulty: 'hard',
    applicableDomains: ['backend', 'data-science'],
    hints: ['Water at each position = min(maxLeft, maxRight) - height.', 'Use two pointers or prefix max arrays.'],
    starterCode: {
      python: 'def trap(height: list[int]) -> int:\n    pass',
      javascript: 'function trap(height) {\n  \n}',
    },
    expectedTimeMinutes: 25,
    tags: ['monotonic-stack', 'two-pointers', 'arrays'],
  },
  {
    id: 'longest-increasing-subsequence',
    title: 'Longest Increasing Subsequence',
    description: 'Given an integer array `nums`, return the length of the longest strictly increasing subsequence.',
    examples: [
      { input: 'nums = [10,9,2,5,3,7,101,18]', output: '4', explanation: '[2,3,7,101]' },
    ],
    constraints: ['1 <= nums.length <= 2500'],
    difficulty: 'hard',
    applicableDomains: ['backend', 'data-science'],
    hints: ['DP: dp[i] = longest subsequence ending at i.', 'O(n log n) possible with binary search + patience sorting.'],
    starterCode: {
      python: 'def length_of_lis(nums: list[int]) -> int:\n    pass',
      javascript: 'function lengthOfLIS(nums) {\n  \n}',
    },
    expectedTimeMinutes: 20,
    tags: ['dynamic-programming', 'binary-search'],
  },
  {
    id: 'alien-dictionary',
    title: 'Alien Dictionary',
    description: 'Given a sorted list of words in an alien language, derive the order of characters in the alphabet. Return the characters in order. If invalid, return "".',
    examples: [
      { input: 'words = ["wrt","wrf","er","ett","rftt"]', output: '"wertf"' },
    ],
    constraints: ['1 <= words.length <= 100', '1 <= words[i].length <= 100'],
    difficulty: 'hard',
    applicableDomains: ['backend', 'data-science'],
    hints: ['Build a directed graph from adjacent word comparisons.', 'Topological sort the graph to get the ordering.'],
    starterCode: {
      python: 'def alien_order(words: list[str]) -> str:\n    pass',
      javascript: 'function alienOrder(words) {\n  \n}',
    },
    expectedTimeMinutes: 30,
    tags: ['graph', 'topological-sort'],
  },
  {
    id: 'regular-expression-matching',
    title: 'Regular Expression Matching',
    description: 'Implement regular expression matching with support for `.` (matches any single character) and `*` (matches zero or more of the preceding element). The matching should cover the entire input string.',
    examples: [
      { input: 's = "aa", p = "a*"', output: 'true' },
      { input: 's = "ab", p = ".*"', output: 'true' },
    ],
    constraints: ['1 <= s.length <= 20', '1 <= p.length <= 20'],
    difficulty: 'hard',
    applicableDomains: ['backend'],
    hints: ['Use DP: dp[i][j] = does s[0..i] match p[0..j]?', 'Handle * by either using it 0 times or 1+ times.'],
    starterCode: {
      python: 'def is_match(s: str, p: str) -> bool:\n    pass',
      javascript: 'function isMatch(s, p) {\n  \n}',
    },
    expectedTimeMinutes: 30,
    tags: ['dynamic-programming', 'recursion', 'strings'],
  },
  {
    id: 'design-twitter',
    title: 'Design Twitter',
    description: 'Design a simplified Twitter: `postTweet(userId, tweetId)`, `getNewsFeed(userId)` (10 most recent tweets from user + followed users), `follow(followerId, followeeId)`, `unfollow(followerId, followeeId)`.',
    examples: [
      { input: 'postTweet(1, 5); getNewsFeed(1)', output: '[5]' },
    ],
    constraints: ['1 <= userId, tweetId <= 500', 'getNewsFeed returns at most 10 tweets'],
    difficulty: 'hard',
    applicableDomains: ['backend', 'frontend'],
    hints: ['Use a heap to merge sorted tweet lists.', 'Store tweets per user and follow sets.'],
    starterCode: {
      python: 'class Twitter:\n    def __init__(self):\n        pass\n\n    def post_tweet(self, user_id: int, tweet_id: int) -> None:\n        pass\n\n    def get_news_feed(self, user_id: int) -> list[int]:\n        pass\n\n    def follow(self, follower_id: int, followee_id: int) -> None:\n        pass\n\n    def unfollow(self, follower_id: int, followee_id: int) -> None:\n        pass',
      javascript: 'class Twitter {\n  postTweet(userId, tweetId) {\n    \n  }\n  getNewsFeed(userId) {\n    \n  }\n  follow(followerId, followeeId) {\n    \n  }\n  unfollow(followerId, followeeId) {\n    \n  }\n}',
    },
    expectedTimeMinutes: 30,
    tags: ['design', 'heap'],
  },
  {
    id: 'sliding-window-maximum',
    title: 'Sliding Window Maximum',
    description: 'Given an array `nums` and a sliding window of size `k`, return the max value in each window as it slides from left to right.',
    examples: [
      { input: 'nums = [1,3,-1,-3,5,3,6,7], k = 3', output: '[3,3,5,5,6,7]' },
    ],
    constraints: ['1 <= nums.length <= 10^5', '1 <= k <= nums.length'],
    difficulty: 'hard',
    applicableDomains: ['backend', 'data-science'],
    hints: ['Use a monotonic decreasing deque.', 'Remove elements outside the window and smaller than current.'],
    starterCode: {
      python: 'def max_sliding_window(nums: list[int], k: int) -> list[int]:\n    pass',
      javascript: 'function maxSlidingWindow(nums, k) {\n  \n}',
    },
    expectedTimeMinutes: 25,
    tags: ['monotonic-stack', 'queue', 'sliding-window'],
  },
  {
    id: 'implement-autocomplete',
    title: 'Implement Autocomplete System',
    description: 'Design an autocomplete system. Given a set of sentences with their frequencies, implement: `input(c)` that takes a character and returns the top 3 matching sentences sorted by frequency (then alphabetically).',
    examples: [
      { input: 'AutocompleteSystem(["i love you","island","iroman"], [5,3,2]); input("i")', output: '["i love you","island","iroman"]' },
    ],
    constraints: ['1 <= sentences.length <= 1000', '1 <= sentence.length <= 200'],
    difficulty: 'hard',
    applicableDomains: ['backend', 'frontend'],
    hints: ['Use a Trie to store sentences.', 'At each node, maintain a sorted list of top completions.'],
    starterCode: {
      python: 'class AutocompleteSystem:\n    def __init__(self, sentences: list[str], times: list[int]):\n        pass\n\n    def input(self, c: str) -> list[str]:\n        pass',
      javascript: 'class AutocompleteSystem {\n  constructor(sentences, times) {\n    \n  }\n  input(c) {\n    \n  }\n}',
    },
    expectedTimeMinutes: 30,
    tags: ['trie', 'design', 'frontend-specific'],
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
  const primaryDifficulty = experience === '7+' ? 'hard' : experience === '3-6' ? 'medium' : 'easy'

  // Try primary difficulty first, then adjacent difficulties
  const difficultyOrder: Array<CodingProblem['difficulty']> =
    primaryDifficulty === 'easy' ? ['easy', 'medium'] :
    primaryDifficulty === 'hard' ? ['hard', 'medium'] :
    ['medium', 'easy', 'hard']

  for (const diff of difficultyOrder) {
    const candidates = CODING_PROBLEMS.filter(
      (p) => p.difficulty === diff &&
      p.applicableDomains.includes(domain) &&
      !usedIds.includes(p.id)
    )
    if (candidates.length > 0) {
      return candidates[Math.floor(Math.random() * candidates.length)]
    }
  }

  // All problems in pool exhausted for this domain — return null (triggers AI generation)
  return null
}
