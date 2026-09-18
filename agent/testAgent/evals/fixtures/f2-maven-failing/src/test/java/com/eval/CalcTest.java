package com.eval;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertEquals;

class CalcTest {
    @Test
    void sumShouldIncludeAllElements() {
        assertEquals(10, Calc.sum(new int[]{1, 2, 3, 4}));
    }
}
