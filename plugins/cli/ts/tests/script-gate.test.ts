import { describe, expect, test } from "bun:test";
import { Dropped, Gate } from "../src/browse/script/host.ts";
import { ArgumentsTooDeep, evaluateExpression, frameFunction, literal, selectorExpression, validEvaluate } from "../src/browse/script/page-calls.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the script's call gate", () => {
  test("reads run side by side, up to the limit", async () => {
    const gate = new Gate(3);
    const holds = Array.from({ length: 5 }, deferred);
    let running = 0;
    const runs = holds.map((hold) => gate.run(false, async () => {
      running += 1;
      await hold.promise;
      running -= 1;
    }));
    await tick();
    expect(running).toBe(3);
    holds[0]?.resolve();
    await tick();
    expect(running).toBe(3);
    for (const hold of holds) hold.resolve();
    await Promise.all(runs);
    expect(gate.peak).toBe(3);
  });

  test("an action waits for the reads before it, and reads after it wait for it", async () => {
    const gate = new Gate(8);
    const order: string[] = [];
    const first = deferred();
    const read1 = gate.run(false, async () => {
      order.push("read1 start");
      await first.promise;
      order.push("read1 end");
    });
    const click = gate.run(true, async () => {
      order.push("click");
    });
    const read2 = gate.run(false, async () => {
      order.push("read2");
    });
    await tick();
    expect(order).toEqual(["read1 start"]);
    first.resolve();
    await Promise.all([read1, click, read2]);
    expect(order).toEqual(["read1 start", "read1 end", "click", "read2"]);
  });

  test("actions run one at a time in the order they came", async () => {
    const gate = new Gate(8);
    const order: number[] = [];
    let active = 0;
    await Promise.all([1, 2, 3, 4].map((n) => gate.run(true, async () => {
      active += 1;
      expect(active).toBe(1);
      await tick();
      order.push(n);
      active -= 1;
    })));
    expect(order).toEqual([1, 2, 3, 4]);
  });

  test("calls still queued when the script ends never run", async () => {
    const gate = new Gate(8);
    const hold = deferred();
    const ran: string[] = [];
    const busy = gate.run(true, async () => {
      await hold.promise;
      ran.push("first");
    });
    const queued = gate.run(true, async () => {
      ran.push("second");
    });
    await tick();
    expect(gate.dropQueued()).toBe(1);
    hold.resolve();
    await busy;
    await expect(queued).rejects.toBeInstanceOf(Dropped);
    expect(ran).toEqual(["first"]);
  });
});

describe("a closed gate", () => {
  test("refuses new calls and drops admitted ones that hadn't started", async () => {
    const gate = new Gate(1);
    const hold = deferred();
    const ran: string[] = [];
    const busy = gate.run(false, async () => {
      await hold.promise;
      ran.push("busy");
    });
    const waiting = gate.run(false, async () => {
      ran.push("waiting");
    });
    await tick();
    expect(gate.close()).toBe(1);
    await expect(gate.run(true, async () => ran.push("late"))).rejects.toBeInstanceOf(Dropped);
    hold.resolve();
    await busy;
    await expect(waiting).rejects.toBeInstanceOf(Dropped);
    expect(ran).toEqual(["busy"]);
  });
});

function evaluateWith(expression: string, document: unknown): unknown {
  return new Function("document", `return (${expression});`)(document);
}

const DOCUMENT = {
  querySelector: (selector: string) => (selector === "h1" ? { textContent: "Models" } : null),
  querySelectorAll: (selector: string) => (selector === "a.row" ? [{ href: "/a" }, { href: "/b" }, { href: "/c" }] : []),
};

describe("page calls a script makes", () => {
  test("evaluate passes every argument", () => {
    expect(evaluateWith(evaluateExpression({ op: "evaluate", fn: "(a, b, c) => [a + b, c.x]", isFunction: true, args: [1, 2, { x: "y" }] }), DOCUMENT)).toEqual([3, "y"]);
    expect(evaluateExpression({ op: "evaluate", fn: "document.title", isFunction: false, args: [] })).toBe("document.title");
  });

  test("arguments arrive as JSON, own __proto__ keys included", () => {
    const args = JSON.parse('[{"__proto__": {"x": 1}, "y": 2}]') as unknown[];
    expect(evaluateWith(evaluateExpression({ op: "evaluate", fn: "(o) => [Object.keys(o).sort(), o.y]", isFunction: true, args }), DOCUMENT)).toEqual([["__proto__", "y"], 2]);
  });

  test("arguments are literals, so the page's own JSON.parse never sees them", () => {
    const expression = evaluateExpression({ op: "evaluate", fn: "(n) => n", isFunction: true, args: [7] });
    expect(expression).not.toContain("JSON");
    expect(new Function("JSON", `return (${expression});`)({ parse: () => [99] })).toBe(7);
    expect(literal({ a: [1, "x", null, true], "": -0 })).toBe('{["a"]:[1,"x",null,true],[""]:-0}');
    let deep: unknown = 1;
    for (let i = 0; i < 600; i += 1) deep = [deep];
    expect(() => literal(deep)).toThrow(ArgumentsTooDeep);
  });

  test("$eval hands over the element and fails clearly when nothing matches", () => {
    expect(evaluateWith(selectorExpression({ op: "$eval", selector: "h1", fn: "(h, suffix) => h.textContent + suffix", args: ["!"] }), DOCUMENT)).toBe("Models!");
    expect(() => evaluateWith(selectorExpression({ op: "$eval", selector: "h2", fn: "(h) => h", args: [] }), DOCUMENT)).toThrow("page.$eval: no element matches h2");
  });

  test("$$eval hands over every match as an array", () => {
    expect(evaluateWith(selectorExpression({ op: "$$eval", selector: "a.row", fn: "(links, n) => links.slice(0, n).map((a) => a.href)", args: [2] }), DOCUMENT)).toEqual(["/a", "/b"]);
    expect(evaluateWith(selectorExpression({ op: "$$eval", selector: "nothing", fn: "(links) => links.length", args: [] }), DOCUMENT)).toBe(0);
  });

  test("selectors are written as literals, so eval's quoting repair sees them", () => {
    expect(selectorExpression({ op: "$$eval", selector: "a[href*=/models/]", fn: "(a) => a", args: [] })).toContain('document.querySelectorAll("a[href*=/models/]")');
  });

  test("frame calls take the same shapes as page calls", () => {
    const [evaluate, evaluateArgs] = frameFunction({ op: "evaluate", fn: "(a, b) => a * b", isFunction: true, args: [6, 7] });
    expect(new Function(`return (${evaluate});`)()(...evaluateArgs)).toBe(42);
    const [all, allArgs] = frameFunction({ op: "$$eval", selector: "a.row", fn: "(links) => links.length", args: [] });
    expect(new Function("document", `return (${all});`)(DOCUMENT)(...allArgs)).toBe(3);
  });

  test("bad calls are refused before they reach the page", () => {
    expect(validEvaluate({ op: "evaluate", fn: "", isFunction: true, args: [] })).toBe("page.evaluate() takes a function");
    expect(validEvaluate({ op: "evaluate", fn: "document.title", isFunction: false, args: [1] })).toContain("takes no arguments");
    expect(validEvaluate({ op: "$eval", fn: "(e) => e", isFunction: true, args: [], selector: "" })).toBe("page.$eval() takes a CSS selector first");
    expect(validEvaluate({ op: "evaluate", fn: "x".repeat(300 * 1024), isFunction: false })).toContain("over 256 KB");
    expect(validEvaluate({ op: "$$eval", fn: "(e) => e", isFunction: true, args: [], selector: "a" })).toBeNull();
  });
});
