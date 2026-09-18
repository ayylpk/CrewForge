// calc.ts —— 数值工具

export function sum(nums: number[]): number {
  let total = 0;
  for (const n of nums) {
    total += n;
  }
  return total;
}

export function avg(nums: number[]): number {
  return sum(nums) / nums.length;
}
