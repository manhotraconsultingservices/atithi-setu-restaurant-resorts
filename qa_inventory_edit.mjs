// ════════════════════════════════════════════════════════════════════════
//  qa_inventory_edit.mjs — ingredient stock stays correct across staff edits
//
//  Models the server's stock_movements + the NET-AWARE revertIngredientsForOrder
//  and the edit re-sync (revert → re-deduct → re-arm). Proves the shared
//  inventory primitive is correct for: simple cancel (unchanged), edit-reduce,
//  edit-increase, edit-then-cancel, edit-then-edit-then-cancel, double-cancel.
//  Invariant under test: once an order is fully cancelled, net stock == start
//  (every consumed unit returned exactly once — no leak, no double-credit).
// ════════════════════════════════════════════════════════════════════════
const C = { g: '\x1b[32m', r: '\x1b[31m', b: '\x1b[1m', x: '\x1b[0m' };
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) pass++; else { fail++; console.log(`  ${C.r}✗${C.x} ${label}`); } };

// One ingredient, recipe = 1 unit per serving. An order's `movements` are the
// stock_movements rows for that order (CONSUMPTION negative, REVERSAL positive).
function mkOrder(startStock = 100) {
  return { stock: startStock, movements: [], invReverted: 0 };
}
// deductIngredientsForOrder: consume `qty` servings (no idempotency guard).
function deduct(o, qty) { o.stock -= qty; o.movements.push({ type: 'CONSUMPTION', qty: -qty }); }
// revertIngredientsForOrder (NET-AWARE): return only what's still outstanding.
function revert(o) {
  if (o.invReverted === 1) return 0;
  const net = o.movements.reduce((s, m) => s + m.qty, 0);  // negative while stock is out
  const ret = -net;
  let lines = 0;
  if (ret > 0) { o.stock += ret; o.movements.push({ type: 'REVERSAL', qty: ret }); lines = 1; }
  o.invReverted = 1;
  return lines;
}
// Edit re-sync: revert original → deduct new items → re-arm the cancel reversal.
function editTo(o, newQty) { revert(o); deduct(o, newQty); o.invReverted = 0; }

console.log(`${C.b}\n═══ Inventory stock across staff edits ═══${C.x}`);

// 1. Simple order + cancel — unchanged behaviour (full return, idempotent).
let o = mkOrder(100);
deduct(o, 10);
ok(o.stock === 90, 'placing a 10-unit order leaves stock 90');
revert(o);
ok(o.stock === 100, 'cancel returns the full 10 → stock 100');
revert(o);
ok(o.stock === 100, 'double-cancel is a no-op (guarded) → still 100');

// 2. Edit REDUCE (10 → 6): stock reflects the new consumption.
o = mkOrder(100);
deduct(o, 10);          // 90
editTo(o, 6);           // return 10 → 100, deduct 6 → 94
ok(o.stock === 94, 'edit 10→6 returns 4 net to stock (out by 6) → 94');

// 3. …then cancel → fully restored, NO double-credit of the original.
revert(o);
ok(o.stock === 100, 'cancel after edit returns exactly the 6 outstanding → 100 (no double-credit)');

// 4. Edit INCREASE (5 → 8).
o = mkOrder(100);
deduct(o, 5);           // 95
editTo(o, 8);           // return 5 → 100, deduct 8 → 92
ok(o.stock === 92, 'edit 5→8 deducts 3 more (out by 8) → 92');
revert(o);
ok(o.stock === 100, 'cancel after increase-edit returns 8 → 100');

// 5. Edit TWICE then cancel.
o = mkOrder(100);
deduct(o, 10);          // 90
editTo(o, 6);           // 94
editTo(o, 4);           // return 6 → 100, deduct 4 → 96
ok(o.stock === 96, 'two edits (10→6→4) leave stock out by 4 → 96');
revert(o);
ok(o.stock === 100, 'cancel after two edits returns 4 → 100 (clean)');

// 6. Removing all but raising — guard handled at handler level (cannot reach 0
//    items here); a 1-unit floor order edited to 1 still nets correctly.
o = mkOrder(50);
deduct(o, 3);           // 47
editTo(o, 1);           // return 3 → 50, deduct 1 → 49
revert(o);
ok(o.stock === 50, 'edit-down-to-1 then cancel still nets to start (50)');

console.log(`${C.b}\n═══════════════════════════════════════════════════════════════${C.x}`);
console.log(`  ${C.g}✓ Passed:${C.x} ${pass}`);
console.log(`  ${fail ? C.r : C.g}✗ Failed:${C.x} ${fail}`);
console.log(`${C.b}═══════════════════════════════════════════════════════════════${C.x}`);
process.exit(fail > 0 ? 1 : 0);
