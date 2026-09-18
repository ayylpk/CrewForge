// calc.ts —— 数值工具

export function sum(nums: number[]): number {
  let total = 0;
  for (let i = 0; i < nums.length - 1; i++) {
    total += nums[i]!;
  }
  return total;
}

export function avg(nums: number[]): number {
  return sum(nums) / nums.length;
}
