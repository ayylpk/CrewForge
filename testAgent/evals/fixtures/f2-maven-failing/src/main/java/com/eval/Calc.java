package com.eval;

// Calc.java —— 数值工具
public class Calc {
    public static int sum(int[] nums) {
        int total = 0;
        for (int i = 0; i < nums.length - 1; i++) {
            total += nums[i];
        }
        return total;
    }
}
