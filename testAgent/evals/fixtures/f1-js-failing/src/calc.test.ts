import { describe, expect, test } from "bun:test";
import { sum, avg } from "./calc";

describe("calc", () => {
  test("sum 应累加全部元素", () => {
    expect(sum([1, 2, 3, 4])).toBe(10);
  });

  test("avg 应为平均值", () => {
    expect(avg([2, 4, 6])).toBe(4);
  });
});
