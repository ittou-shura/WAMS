const express = require("express");
const sqlite3 = require("sqlite3").verbose();

const app = express();
const PORT = process.env.PORT || 3000;
const FIXED_UNIT_PRICE = 100;

const db = new sqlite3.Database("./wams.db");

app.use(express.json());

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) {
        reject(err);
        return;
      }
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(rows);
    });
  });
}

function toPositiveInt(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    return null;
  }
  return n;
}

function toNonNegativeInt(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    return null;
  }
  return n;
}

async function ensureEntityExists(table, idField, idValue) {
  const row = await get(`SELECT * FROM ${table} WHERE ${idField} = ?`, [idValue]);
  return row;
}

async function createInvoiceIfAllowed(orderId) {
  const existing = await get("SELECT * FROM Invoice WHERE so_id = ?", [orderId]);
  if (existing) {
    return { invoice: existing, created: false };
  }

  const order = await get("SELECT so_id, quantity, status FROM SalesOrder WHERE so_id = ?", [orderId]);
  if (!order) {
    const err = new Error("Order not found");
    err.code = "NOT_FOUND";
    throw err;
  }

  if (!["ACCEPTED", "COMPLETED"].includes(order.status)) {
    const err = new Error("Invoice can be generated only for ACCEPTED or COMPLETED orders");
    err.code = "INVALID_STATE";
    throw err;
  }

  const total = order.quantity * FIXED_UNIT_PRICE;
  const insert = await run("INSERT INTO Invoice (so_id, total) VALUES (?, ?)", [order.so_id, total]);
  const invoice = await get("SELECT * FROM Invoice WHERE invoice_id = ?", [insert.lastID]);
  return { invoice, created: true };
}

async function tryCompletePendingOrder(orderId) {
  const order = await get(
    `SELECT so.so_id, so.product_id, so.quantity, so.status, p.stock_qty AS product_stock
     FROM SalesOrder so
     JOIN Product p ON p.product_id = so.product_id
     WHERE so.so_id = ?`,
    [orderId]
  );

  if (!order) {
    return { completed: false, reason: "Sales order not found" };
  }

  if (order.status !== "PENDING") {
    return { completed: false, reason: `Sales order status is ${order.status}` };
  }

  const requiredProductionQty = Math.max(0, order.quantity - order.product_stock);
  const partId = order.product_id;

  if (requiredProductionQty > 0) {
    const part = await get("SELECT part_id, stock_qty FROM Parts WHERE part_id = ?", [partId]);
    if (!part) {
      return { completed: false, reason: `Mapped part ${partId} does not exist` };
    }
    if (part.stock_qty < requiredProductionQty) {
      return {
        completed: false,
        reason: `Not enough parts stock to produce. Needed=${requiredProductionQty}, Available=${part.stock_qty}`,
      };
    }
  }

  await run("BEGIN TRANSACTION");
  try {
    if (requiredProductionQty > 0) {
      const partUpdate = await run(
        "UPDATE Parts SET stock_qty = stock_qty - ? WHERE part_id = ? AND stock_qty >= ?",
        [requiredProductionQty, partId, requiredProductionQty]
      );
      if (!partUpdate.changes) {
        throw new Error("Parts stock update failed during production");
      }

      await run("UPDATE Product SET stock_qty = stock_qty + ? WHERE product_id = ?", [
        requiredProductionQty,
        order.product_id,
      ]);
    }

    const shipUpdate = await run(
      "UPDATE Product SET stock_qty = stock_qty - ? WHERE product_id = ? AND stock_qty >= ?",
      [order.quantity, order.product_id, order.quantity]
    );
    if (!shipUpdate.changes) {
      throw new Error("Product stock is still insufficient to complete pending order");
    }

    await run("UPDATE SalesOrder SET status = 'COMPLETED', updated_at = CURRENT_TIMESTAMP WHERE so_id = ?", [
      order.so_id,
    ]);

    await run("INSERT OR IGNORE INTO Invoice (so_id, total) VALUES (?, ?)", [
      order.so_id,
      order.quantity * FIXED_UNIT_PRICE,
    ]);

    await run("COMMIT");
  } catch (err) {
    await run("ROLLBACK");
    throw err;
  }

  const completedOrder = await get("SELECT * FROM SalesOrder WHERE so_id = ?", [order.so_id]);
  const invoice = await get("SELECT * FROM Invoice WHERE so_id = ?", [order.so_id]);

  return {
    completed: true,
    required_production_qty: requiredProductionQty,
    order: completedOrder,
    invoice,
  };
}

async function initDb() {
  await run("PRAGMA foreign_keys = ON");

  await run(
    `CREATE TABLE IF NOT EXISTS User (
      user_id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL,
      password TEXT NOT NULL
    )`
  );

  await run(
    `CREATE TABLE IF NOT EXISTS Dealer (
      dealer_id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    )`
  );

  await run(
    `CREATE TABLE IF NOT EXISTS Supplier (
      supplier_id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    )`
  );

  await run(
    `CREATE TABLE IF NOT EXISTS Product (
      product_id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      stock_qty INTEGER NOT NULL DEFAULT 0
    )`
  );

  await run(
    `CREATE TABLE IF NOT EXISTS Parts (
      part_id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      stock_qty INTEGER NOT NULL DEFAULT 0
    )`
  );

  await run(
    `CREATE TABLE IF NOT EXISTS SalesOrder (
      so_id INTEGER PRIMARY KEY AUTOINCREMENT,
      dealer_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (dealer_id) REFERENCES Dealer(dealer_id),
      FOREIGN KEY (product_id) REFERENCES Product(product_id)
    )`
  );

  await run(
    `CREATE TABLE IF NOT EXISTS PurchaseOrder (
      po_id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier_id INTEGER NOT NULL,
      part_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      status TEXT NOT NULL,
      sales_order_id INTEGER,
      product_id INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (supplier_id) REFERENCES Supplier(supplier_id),
      FOREIGN KEY (part_id) REFERENCES Parts(part_id),
      FOREIGN KEY (sales_order_id) REFERENCES SalesOrder(so_id),
      FOREIGN KEY (product_id) REFERENCES Product(product_id)
    )`
  );

  await run(
    `CREATE TABLE IF NOT EXISTS Quotation (
      quote_id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier_id INTEGER NOT NULL,
      part_id INTEGER NOT NULL,
      price REAL NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (supplier_id) REFERENCES Supplier(supplier_id),
      FOREIGN KEY (part_id) REFERENCES Parts(part_id)
    )`
  );

  await run(
    `CREATE TABLE IF NOT EXISTS Invoice (
      invoice_id INTEGER PRIMARY KEY AUTOINCREMENT,
      so_id INTEGER NOT NULL UNIQUE,
      total REAL NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (so_id) REFERENCES SalesOrder(so_id)
    )`
  );

  const dealerCount = await get("SELECT COUNT(*) AS count FROM Dealer");
  if (dealerCount.count === 0) {
    await run("INSERT INTO Dealer (name) VALUES (?)", ["Default Dealer"]);
  }

  const supplierCount = await get("SELECT COUNT(*) AS count FROM Supplier");
  if (supplierCount.count === 0) {
    await run("INSERT INTO Supplier (name) VALUES (?)", ["Default Supplier"]);
  }
}

app.get("/", (req, res) => {
  res.send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>WAMS Role UI</title>
    <style>
      :root {
        --bg: #eef3f8;
        --panel: #ffffff;
        --text: #1c2a38;
        --line: #d2dce8;
        --muted: #607184;
        --primary: #0a6ca7;
        --ok: #226843;
        --warn: #986205;
        --err: #9a2f2f;
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
        color: var(--text);
        background: linear-gradient(180deg, #edf3fa 0%, #f7fbff 100%);
      }
      .app {
        max-width: 1100px;
        margin: 0 auto;
        padding: 18px;
      }
      .panel {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 16px;
        box-shadow: 0 10px 24px rgba(16, 33, 51, 0.06);
      }
      .hidden {
        display: none;
      }
      h1,
      h2,
      h3,
      h4 {
        margin-top: 0;
      }
      .muted {
        color: var(--muted);
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
        gap: 12px;
      }
      .card {
        border: 1px solid var(--line);
        border-radius: 10px;
        background: #fff;
        padding: 12px;
      }
      .stack {
        display: grid;
        gap: 10px;
      }
      .inline {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
      }
      .grow {
        flex: 1;
      }
      label {
        display: block;
        font-size: 13px;
        margin-top: 8px;
        color: #385162;
      }
      input,
      select {
        width: 100%;
        margin-top: 4px;
        border: 1px solid #c5d3e1;
        border-radius: 8px;
        padding: 8px 10px;
        font-size: 14px;
      }
      button {
        border: 1px solid #b8c9db;
        border-radius: 8px;
        padding: 8px 12px;
        cursor: pointer;
        background: #fff;
        color: #18425e;
        font-weight: 600;
      }
      button:hover {
        background: #edf6fd;
      }
      .primary {
        background: var(--primary);
        border-color: var(--primary);
        color: #fff;
      }
      .primary:hover {
        background: #085985;
      }
      .danger {
        border-color: #d8aaaa;
        color: #8d2727;
      }
      .small {
        padding: 5px 8px;
        font-size: 12px;
      }
      .nav {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .message {
        margin-top: 10px;
        border: 1px solid #cfd8e3;
        border-radius: 8px;
        padding: 10px;
        background: #f7fbff;
      }
      .message.ok {
        border-color: #9ecdb2;
        background: #eaf7ef;
        color: var(--ok);
      }
      .message.warn {
        border-color: #efcf93;
        background: #fff7e6;
        color: var(--warn);
      }
      .message.err {
        border-color: #e2b4b4;
        background: #fdeeee;
        color: var(--err);
      }
      .section {
        margin-top: 12px;
      }
      .badge {
        display: inline-block;
        border: 1px solid #c8d5e2;
        border-radius: 999px;
        padding: 4px 10px;
        font-size: 12px;
        background: #f7fbff;
      }
      .badge.pending {
        border-color: #efd08b;
        background: #fff5de;
        color: #8e5b00;
      }
      .badge.accepted,
      .badge.completed {
        border-color: #a5d6b5;
        background: #e9f8ef;
        color: #1f6640;
      }
      .badge.cancelled,
      .badge.rejected {
        border-color: #e0b4b4;
        background: #fcecec;
        color: #8f2929;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        margin-top: 8px;
      }
      th,
      td {
        border: 1px solid var(--line);
        padding: 7px;
        text-align: left;
        vertical-align: top;
      }
      th {
        background: #edf5fd;
      }
      @media (max-width: 720px) {
        .app {
          padding: 12px;
        }
      }
    </style>
  </head>
  <body>
    <div class="app">
      <div id="loginPage" class="panel">
        <h1>Web Based Automated Manufacturing System</h1>
        <p class="muted">Register or login first. After login, role-specific features are shown.</p>
        <div class="grid">
          <div class="card">
            <h3>Register</h3>
            <form id="registerForm" action="#">
              <label>Name
                <input name="name" required />
              </label>
              <label>Role
                <select name="role" required>
                  <option value="DEALER">DEALER</option>
                  <option value="MANUFACTURER">MANUFACTURER</option>
                  <option value="SUPPLIER">SUPPLIER</option>
                </select>
              </label>
              <label>Password
                <input name="password" type="password" required />
              </label>
              <button class="primary" type="submit">Register</button>
            </form>
          </div>

          <div class="card">
            <h3>Login</h3>
            <form id="loginForm" action="#">
              <label>Name
                <input name="name" required />
              </label>
              <label>Password
                <input name="password" type="password" required />
              </label>
              <button class="primary" type="submit">Login</button>
            </form>
          </div>
        </div>
        <div id="authMessage" class="message hidden"></div>
      </div>

      <div id="dashboard" class="panel hidden">
        <div class="inline">
          <h2 style="margin: 0">Dashboard</h2>
          <div class="grow"></div>
          <div id="loggedInRole" class="badge"></div>
        </div>
        <div class="nav" style="margin-top: 10px">
          <button id="dashboardBtn">Dashboard</button>
          <button id="openRoleBtn" class="primary">Open Role Actions</button>
          <button id="logoutBtn">Logout</button>
        </div>

        <div id="dashboardHome" class="section card">
          <h3>Welcome</h3>
          <p id="roleScopeText" class="muted"></p>
          <div id="dashboardSummary" class="message">Login to load summary.</div>
        </div>

        <div id="dealerSection" class="section hidden">
          <div class="card">
            <h3>Dealer Actions</h3>
            <p class="muted">Allowed: Place Order, Cancel Order, Check Order Status.</p>
          </div>
          <div class="grid">
            <div class="card">
              <h4>Place Order</h4>
              <form id="dealerPlaceOrderForm" action="#">
                <label>Dealer ID
                  <input name="dealer_id" type="number" min="1" value="1" required />
                </label>
                <label>Product ID
                  <input name="product_id" type="number" min="1" required />
                </label>
                <label>Quantity
                  <input name="quantity" type="number" min="1" required />
                </label>
                <button class="primary" type="submit">Place Order</button>
              </form>
              <button id="resolveSupplierBtn" class="hidden" style="margin-top: 10px">Resolve via Supplier</button>
            </div>

            <div class="card">
              <h4>Check / Cancel Order</h4>
              <form id="dealerCheckOrderForm" action="#">
                <label>Order ID
                  <input name="order_id" type="number" min="1" required />
                </label>
                <button type="submit">Check Status</button>
              </form>

              <form id="dealerCancelOrderForm" action="#" style="margin-top: 10px">
                <label>Order ID
                  <input name="order_id" type="number" min="1" required />
                </label>
                <button class="danger" type="submit">Cancel Order</button>
              </form>
            </div>
          </div>
          <div id="dealerMessage" class="message hidden"></div>
          <div id="dealerOrderResult" class="card" style="margin-top: 10px"></div>
        </div>

        <div id="manufacturerSection" class="section hidden">
          <div class="card">
            <h3>Manufacturer Actions</h3>
            <p class="muted">Allowed: Product/Parts management, Inventory view, Create Purchase Order.</p>
          </div>

          <div class="grid">
            <div class="card">
              <h4>Product Management</h4>
              <form id="manufacturerAddProductForm" action="#">
                <label>Name
                  <input name="name" required />
                </label>
                <label>Stock Qty
                  <input name="stock_qty" type="number" min="0" required />
                </label>
                <button class="primary" type="submit">Add Product</button>
              </form>
              <form id="manufacturerDeleteProductForm" action="#" style="margin-top: 8px">
                <label>Product ID
                  <input name="product_id" type="number" min="1" required />
                </label>
                <button class="danger" type="submit">Remove Product</button>
              </form>
              <button id="manufacturerRefreshProductsBtn" style="margin-top: 8px">Show Product List</button>
              <div id="manufacturerProductMessage" class="message hidden"></div>
              <div id="manufacturerProductsList" class="stack"></div>
            </div>

            <div class="card">
              <h4>Parts Management</h4>
              <form id="manufacturerAddPartsForm" action="#">
                <label>Name
                  <input name="name" required />
                </label>
                <label>Stock Qty
                  <input name="stock_qty" type="number" min="0" required />
                </label>
                <button class="primary" type="submit">Add Parts</button>
              </form>
              <form id="manufacturerDeletePartsForm" action="#" style="margin-top: 8px">
                <label>Part ID
                  <input name="part_id" type="number" min="1" required />
                </label>
                <button class="danger" type="submit">Remove Parts</button>
              </form>
              <button id="manufacturerRefreshPartsBtn" style="margin-top: 8px">Show Parts List</button>
              <div id="manufacturerPartsMessage" class="message hidden"></div>
              <div id="manufacturerPartsList" class="stack"></div>
            </div>
          </div>

          <div class="grid" style="margin-top: 12px">
            <div class="card">
              <h4>Create Purchase Order</h4>
              <form id="manufacturerCreatePoForm" action="#">
                <label>Supplier ID
                  <input name="supplier_id" type="number" min="1" value="1" required />
                </label>
                <label>Part ID
                  <input name="part_id" type="number" min="1" required />
                </label>
                <label>Quantity
                  <input name="quantity" type="number" min="1" required />
                </label>
                <label>Sales Order ID (optional)
                  <input name="sales_order_id" type="number" min="1" />
                </label>
                <label>Product ID (optional)
                  <input name="product_id" type="number" min="1" />
                </label>
                <button class="primary" type="submit">Create Purchase Order</button>
              </form>
              <div id="manufacturerPoMessage" class="message hidden"></div>
            </div>

            <div class="card">
              <h4>Inventory View</h4>
              <button id="manufacturerRefreshInventoryBtn">Refresh Inventory</button>
              <div id="manufacturerInventoryMessage" class="message hidden"></div>
              <div id="manufacturerInventoryView" class="stack"></div>
            </div>
          </div>
        </div>

        <div id="supplierSection" class="section hidden">
          <div class="card">
            <h3>Supplier Actions</h3>
            <p class="muted">Allowed: View Purchase Orders, Provide Quotation, Accept/Reject Purchase Orders.</p>
          </div>

          <div class="grid">
            <div class="card">
              <h4>Provide Quotation</h4>
              <form id="supplierQuotationForm" action="#">
                <label>Supplier ID
                  <input name="supplier_id" type="number" min="1" value="1" required />
                </label>
                <label>Part ID
                  <input name="part_id" type="number" min="1" required />
                </label>
                <label>Price
                  <input name="price" type="number" min="0.01" step="0.01" required />
                </label>
                <button class="primary" type="submit">Submit Quotation</button>
              </form>
            </div>

            <div class="card">
              <h4>Purchase Orders</h4>
              <p class="muted">Current backend exposes pending order-linked purchase orders via order/inventory flow.</p>
              <button id="supplierRefreshPoBtn">View Purchase Orders</button>
            </div>
          </div>

          <div id="supplierMessage" class="message hidden"></div>
          <div id="supplierPoList" class="card" style="margin-top: 10px"></div>
        </div>
      </div>
    </div>

    <script>
      const state = {
        currentUser: null,
        latestPendingOrder: null,
      };

      function byId(id) {
        return document.getElementById(id);
      }

      function normalizeRole(role) {
        return String(role || '').toUpperCase();
      }

      function escapeHtml(value) {
        return String(value)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/\\"/g, '&quot;')
          .replace(/'/g, '&#039;');
      }

      function setHidden(id, hidden) {
        const el = byId(id);
        if (!el) {
          return;
        }
        if (hidden) {
          el.classList.add('hidden');
        } else {
          el.classList.remove('hidden');
        }
      }

      function setMessage(id, text, type) {
        const el = byId(id);
        if (!el) {
          return;
        }
        if (!text) {
          el.className = 'message hidden';
          el.textContent = '';
          return;
        }
        el.className = 'message ' + (type || '');
        el.textContent = text;
      }

      function getErrorMessage(response, fallback) {
        if (response && response.data && response.data.error) {
          return response.data.error;
        }
        return fallback;
      }

      function statusBadge(status) {
        const safe = String(status || 'UNKNOWN').toUpperCase();
        return '<span class="badge ' + safe.toLowerCase() + '">' + escapeHtml(safe) + '</span>';
      }

      async function api(path, method, body) {
        const response = await fetch(path, {
          method: method || 'GET',
          headers: { 'Content-Type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined,
        });

        const text = await response.text();
        let data = {};
        try {
          data = text ? JSON.parse(text) : {};
        } catch (err) {
          data = { raw: text };
        }

        return {
          ok: response.ok,
          status: response.status,
          data,
        };
      }

      function renderTable(columns, rows) {
        if (!rows || rows.length === 0) {
          return '<p class="muted">No records found.</p>';
        }
        let html = '<table><thead><tr>';
        columns.forEach(function (col) {
          html += '<th>' + escapeHtml(col.title) + '</th>';
        });
        html += '</tr></thead><tbody>';
        rows.forEach(function (row) {
          html += '<tr>';
          columns.forEach(function (col) {
            const raw = row[col.key];
            const cell = typeof col.render === 'function' ? col.render(raw, row) : escapeHtml(raw);
            html += '<td>' + (cell === undefined || cell === null ? '' : cell) + '</td>';
          });
          html += '</tr>';
        });
        html += '</tbody></table>';
        return html;
      }

      function resetSections() {
        setHidden('dashboardHome', false);
        setHidden('dealerSection', true);
        setHidden('manufacturerSection', true);
        setHidden('supplierSection', true);
      }

      function showLoginPage() {
        setHidden('loginPage', false);
        setHidden('dashboard', true);
      }

      function showDashboardPage() {
        setHidden('loginPage', true);
        setHidden('dashboard', false);
      }

      function applyRoleDisplay(role) {
        byId('loggedInRole').textContent = 'Logged in as: ' + role + ' (' + state.currentUser.name + ')';

        if (role === 'DEALER') {
          byId('openRoleBtn').textContent = 'Open Dealer Actions';
          byId('roleScopeText').textContent = 'Dealer access: place order, cancel order, and check order status.';
        } else if (role === 'MANUFACTURER') {
          byId('openRoleBtn').textContent = 'Open Manufacturer Actions';
          byId('roleScopeText').textContent =
            'Manufacturer access: manage products/parts, view inventory, and create purchase orders.';
        } else if (role === 'SUPPLIER') {
          byId('openRoleBtn').textContent = 'Open Supplier Actions';
          byId('roleScopeText').textContent =
            'Supplier access: provide quotations and accept/reject purchase orders.';
        } else {
          byId('openRoleBtn').textContent = 'Open Role Actions';
          byId('roleScopeText').textContent = 'No role-specific actions available.';
        }
      }

      async function refreshDashboardSummary() {
        if (!state.currentUser) {
          byId('dashboardSummary').textContent = 'Please login.';
          return;
        }

        const role = state.currentUser.role;

        if (role === 'DEALER') {
          byId('dashboardSummary').innerHTML =
            'Dealer dashboard ready. Use <b>Open Dealer Actions</b> to place/check/cancel orders.';
          return;
        }

        if (role === 'SUPPLIER') {
          const invRes = await api('/inventory', 'GET');
          if (!invRes.ok) {
            byId('dashboardSummary').textContent = 'Supplier summary unavailable.';
            return;
          }
          const pending = invRes.data.pending_shortages || [];
          byId('dashboardSummary').innerHTML =
            'Supplier dashboard ready. Pending shortage orders: <b>' + pending.length + '</b>.';
          return;
        }

        const productsRes = await api('/products', 'GET');
        const partsRes = await api('/parts', 'GET');
        const invRes = await api('/inventory', 'GET');
        if (!productsRes.ok || !partsRes.ok || !invRes.ok) {
          byId('dashboardSummary').textContent = 'Manufacturer summary unavailable.';
          return;
        }
        const products = productsRes.data.products || [];
        const parts = partsRes.data.parts || [];
        const shortages = invRes.data.pending_shortages || [];
        byId('dashboardSummary').innerHTML =
          'Products: <b>' +
          products.length +
          '</b> | Parts: <b>' +
          parts.length +
          '</b> | Pending shortages: <b>' +
          shortages.length +
          '</b>';
      }

      function showRoleSection() {
        if (!state.currentUser) {
          return;
        }

        const role = normalizeRole(state.currentUser.role);
        resetSections();
        setHidden('dashboardHome', true);

        if (role === 'DEALER') {
          setHidden('dealerSection', false);
        } else if (role === 'MANUFACTURER') {
          setHidden('manufacturerSection', false);
          refreshManufacturerProducts();
          refreshManufacturerParts();
          refreshManufacturerInventory();
        } else if (role === 'SUPPLIER') {
          setHidden('supplierSection', false);
          refreshSupplierPurchaseOrders();
        }
      }

      async function loadOrderView(orderId, targetId) {
        const res = await api('/order/' + Number(orderId), 'GET');
        if (!res.ok) {
          return { ok: false, message: getErrorMessage(res, 'Order not found.') };
        }

        const order = res.data.order;
        const invoice = res.data.invoice;
        const purchaseOrders = res.data.purchase_orders || [];

        let html = '<h4>Order ' + escapeHtml(order.so_id) + '</h4>';
        html +=
          '<p><b>Status:</b> ' +
          statusBadge(order.status) +
          '<br><b>Dealer:</b> ' +
          escapeHtml(order.dealer_name) +
          '<br><b>Product:</b> ' +
          escapeHtml(order.product_name) +
          ' (ID ' +
          escapeHtml(order.product_id) +
          ')<br><b>Quantity:</b> ' +
          escapeHtml(order.quantity) +
          '</p>';

        html += '<h4>Linked Purchase Orders</h4>';
        html += renderTable(
          [
            { key: 'po_id', title: 'PO ID' },
            { key: 'part_id', title: 'Part ID' },
            { key: 'quantity', title: 'Quantity' },
            {
              key: 'status',
              title: 'Status',
              render: function (v) {
                return statusBadge(v);
              },
            },
          ],
          purchaseOrders
        );

        if (invoice) {
          html +=
            '<h4>Invoice</h4><p>Invoice ID: <b>' +
            escapeHtml(invoice.invoice_id) +
            '</b><br>Total: <b>' +
            escapeHtml(invoice.total) +
            '</b></p>';
        } else {
          html += '<h4>Invoice</h4><p class="muted">Invoice not generated yet.</p>';
        }

        byId(targetId).innerHTML = html;
        return { ok: true, order };
      }

      async function refreshManufacturerProducts() {
        const res = await api('/products', 'GET');
        if (!res.ok) {
          setMessage('manufacturerProductMessage', 'Unable to load products.', 'err');
          return;
        }
        const rows = res.data.products || [];
        byId('manufacturerProductsList').innerHTML = renderTable(
          [
            { key: 'product_id', title: 'Product ID' },
            { key: 'name', title: 'Name' },
            { key: 'stock_qty', title: 'Stock Qty' },
          ],
          rows
        );
      }

      async function refreshManufacturerParts() {
        const res = await api('/parts', 'GET');
        if (!res.ok) {
          setMessage('manufacturerPartsMessage', 'Unable to load parts.', 'err');
          return;
        }
        const rows = res.data.parts || [];
        byId('manufacturerPartsList').innerHTML = renderTable(
          [
            { key: 'part_id', title: 'Part ID' },
            { key: 'name', title: 'Name' },
            { key: 'stock_qty', title: 'Stock Qty' },
          ],
          rows
        );
      }

      async function refreshManufacturerInventory() {
        const res = await api('/inventory', 'GET');
        if (!res.ok) {
          setMessage('manufacturerInventoryMessage', 'Unable to load inventory.', 'err');
          return;
        }

        const products = res.data.products || [];
        const parts = res.data.parts || [];
        const shortages = res.data.pending_shortages || [];

        let html = '<h4>Product Stock</h4>';
        html += renderTable(
          [
            { key: 'product_id', title: 'Product ID' },
            { key: 'name', title: 'Name' },
            { key: 'stock_qty', title: 'Stock Qty' },
          ],
          products
        );

        html += '<h4>Raw Material Stock</h4>';
        html += renderTable(
          [
            { key: 'part_id', title: 'Part ID' },
            { key: 'name', title: 'Name' },
            { key: 'stock_qty', title: 'Stock Qty' },
          ],
          parts
        );

        html += '<h4>Detected Shortages</h4>';
        html += renderTable(
          [
            { key: 'so_id', title: 'Order ID' },
            { key: 'product_id', title: 'Product ID' },
            { key: 'quantity', title: 'Order Qty' },
            { key: 'shortage', title: 'Shortage' },
          ],
          shortages
        );

        byId('manufacturerInventoryView').innerHTML = html;
        setMessage('manufacturerInventoryMessage', 'Inventory refreshed.', 'ok');
      }

      async function refreshSupplierPurchaseOrders() {
        const list = byId('supplierPoList');
        list.innerHTML = '<p class="muted">Loading purchase orders...</p>';

        const invRes = await api('/inventory', 'GET');
        if (!invRes.ok) {
          list.innerHTML = '<p class="muted">No purchase order data available.</p>';
          setMessage('supplierMessage', getErrorMessage(invRes, 'Could not fetch purchase orders.'), 'err');
          return;
        }

        const pendingShortages = invRes.data.pending_shortages || [];
        const rows = [];
        const seen = {};

        for (let i = 0; i < pendingShortages.length; i += 1) {
          const orderId = pendingShortages[i].so_id;
          const orderRes = await api('/order/' + Number(orderId), 'GET');
          if (!orderRes.ok) {
            continue;
          }
          const order = orderRes.data.order || {};
          const poList = orderRes.data.purchase_orders || [];

          poList.forEach(function (po) {
            if (seen[po.po_id]) {
              return;
            }
            seen[po.po_id] = true;
            rows.push({
              po_id: po.po_id,
              order_id: order.so_id,
              supplier_id: po.supplier_id,
              product_id: order.product_id,
              part_id: po.part_id,
              quantity: po.quantity,
              status: po.status,
            });
          });
        }

        const pendingRows = rows.filter(function (row) {
          return String(row.status).toUpperCase() === 'PENDING';
        });

        if (pendingRows.length === 0) {
          list.innerHTML = '<p class="muted">No pending purchase orders found.</p>';
          return;
        }

        list.innerHTML = renderTable(
          [
            { key: 'po_id', title: 'PO ID' },
            { key: 'order_id', title: 'Order ID' },
            { key: 'supplier_id', title: 'Supplier ID' },
            { key: 'part_id', title: 'Part ID' },
            { key: 'quantity', title: 'Qty' },
            {
              key: 'status',
              title: 'Status',
              render: function (v) {
                return statusBadge(v);
              },
            },
            {
              key: 'po_id',
              title: 'Action',
              render: function (v, row) {
                return (
                  '<button class="small po-action primary" data-po-id="' +
                  escapeHtml(v) +
                  '" data-order-id="' +
                  escapeHtml(row.order_id) +
                  '" data-product-id="' +
                  escapeHtml(row.product_id) +
                  '" data-action="ACCEPT">Accept</button> ' +
                  '<button class="small po-action danger" data-po-id="' +
                  escapeHtml(v) +
                  '" data-order-id="' +
                  escapeHtml(row.order_id) +
                  '" data-product-id="' +
                  escapeHtml(row.product_id) +
                  '" data-action="REJECT">Reject</button>'
                );
              },
            },
          ],
          pendingRows
        );

        document.querySelectorAll('.po-action').forEach(function (button) {
          button.addEventListener('click', async function () {
            const poId = Number(button.getAttribute('data-po-id'));
            const orderId = Number(button.getAttribute('data-order-id'));
            const productId = Number(button.getAttribute('data-product-id'));
            const action = String(button.getAttribute('data-action') || 'ACCEPT').toUpperCase();

            const res = await api('/purchase-order/' + poId + '/respond', 'PUT', { action: action });
            if (!res.ok) {
              setMessage('supplierMessage', getErrorMessage(res, 'Purchase order update failed.'), 'err');
              return;
            }

            let message =
              'Purchase order ' +
              poId +
              ' ' +
              (action === 'ACCEPT' ? 'accepted' : 'rejected') +
              ' successfully.';

            if (action === 'ACCEPT') {
              const completion = res.data.production_and_completion;
              if (completion && completion.completed) {
                message += ' Production completed.';
                const productsRes = await api('/products', 'GET');
                if (productsRes.ok) {
                  const products = productsRes.data.products || [];
                  const product = products.find(function (p) {
                    return Number(p.product_id) === Number(productId);
                  });
                  if (product) {
                    message += ' Updated product stock: Product ' + product.product_id + ' = ' + product.stock_qty + '.';
                  }
                }
              }
            }

            setMessage('supplierMessage', message, action === 'ACCEPT' ? 'ok' : 'warn');
            await refreshSupplierPurchaseOrders();
            await refreshDashboardSummary();

            if (state.currentUser && state.currentUser.role === 'DEALER') {
              await loadOrderView(orderId, 'dealerOrderResult');
            }
          });
        });
      }

      byId('registerForm').addEventListener('submit', async function (event) {
        event.preventDefault();
        const form = event.target;

        const payload = {
          name: form.name.value.trim(),
          role: form.role.value,
          password: form.password.value,
        };

        const res = await api('/register', 'POST', payload);
        if (!res.ok) {
          setMessage('authMessage', getErrorMessage(res, 'Registration failed.'), 'err');
          return;
        }

        setMessage('authMessage', 'Registration successful. Please login.', 'ok');
        form.reset();
      });

      byId('loginForm').addEventListener('submit', async function (event) {
        event.preventDefault();
        const form = event.target;

        const res = await api('/login', 'POST', {
          name: form.name.value.trim(),
          password: form.password.value,
        });

        if (!res.ok) {
          setMessage('authMessage', getErrorMessage(res, 'Login failed.'), 'err');
          return;
        }

        state.currentUser = {
          name: res.data.user.name,
          role: normalizeRole(res.data.user.role),
        };

        showDashboardPage();
        resetSections();
        applyRoleDisplay(state.currentUser.role);
        setMessage('authMessage', '', '');
        await refreshDashboardSummary();
      });

      byId('dashboardBtn').addEventListener('click', async function () {
        resetSections();
        await refreshDashboardSummary();
      });

      byId('openRoleBtn').addEventListener('click', function () {
        showRoleSection();
      });

      byId('logoutBtn').addEventListener('click', function () {
        state.currentUser = null;
        state.latestPendingOrder = null;
        byId('loggedInRole').textContent = '';
        byId('dealerOrderResult').innerHTML = '';
        byId('supplierPoList').innerHTML = '';
        showLoginPage();
      });

      byId('dealerPlaceOrderForm').addEventListener('submit', async function (event) {
        event.preventDefault();
        const form = event.target;
        const payload = {
          dealer_id: Number(form.dealer_id.value),
          product_id: Number(form.product_id.value),
          quantity: Number(form.quantity.value),
        };

        const res = await api('/order', 'POST', payload);
        if (!res.ok) {
          setMessage('dealerMessage', getErrorMessage(res, 'Order placement failed.'), 'err');
          return;
        }

        const order = res.data.order;
        const status = normalizeRole(order.status);
        let message = 'Order placed successfully (Status: ' + status + ').';

        if (status === 'PENDING') {
          state.latestPendingOrder = {
            orderId: order.so_id,
            poId: res.data.purchase_order ? res.data.purchase_order.po_id : null,
          };
          setHidden('resolveSupplierBtn', false);
          message += ' Supplier action is required to resolve shortage.';
        } else {
          state.latestPendingOrder = null;
          setHidden('resolveSupplierBtn', true);
        }

        setMessage('dealerMessage', message, status === 'PENDING' ? 'warn' : 'ok');
        form.reset();
        await loadOrderView(order.so_id, 'dealerOrderResult');
        await refreshDashboardSummary();
      });

      byId('dealerCheckOrderForm').addEventListener('submit', async function (event) {
        event.preventDefault();
        const orderId = Number(event.target.order_id.value);
        const outcome = await loadOrderView(orderId, 'dealerOrderResult');
        if (!outcome.ok) {
          setMessage('dealerMessage', outcome.message, 'err');
          return;
        }
        setMessage('dealerMessage', 'Order status loaded.', 'ok');
      });

      byId('dealerCancelOrderForm').addEventListener('submit', async function (event) {
        event.preventDefault();
        const orderId = Number(event.target.order_id.value);
        const res = await api('/order/' + orderId + '/cancel', 'PUT');
        if (!res.ok) {
          setMessage('dealerMessage', getErrorMessage(res, 'Cancel request failed.'), 'err');
          return;
        }
        setMessage('dealerMessage', 'Order cancelled successfully.', 'ok');
        await loadOrderView(orderId, 'dealerOrderResult');
      });

      byId('resolveSupplierBtn').addEventListener('click', function () {
        const poId = state.latestPendingOrder && state.latestPendingOrder.poId ? state.latestPendingOrder.poId : 'N/A';
        setMessage(
          'dealerMessage',
          'Resolve via Supplier requested. Pending PO: ' + poId + '. Supplier must accept/reject this purchase order.',
          'warn'
        );
      });

      byId('manufacturerAddProductForm').addEventListener('submit', async function (event) {
        event.preventDefault();
        const form = event.target;
        const res = await api('/product', 'POST', {
          name: form.name.value.trim(),
          stock_qty: Number(form.stock_qty.value),
        });

        if (!res.ok) {
          setMessage('manufacturerProductMessage', getErrorMessage(res, 'Failed to add product.'), 'err');
          return;
        }

        setMessage('manufacturerProductMessage', 'Product added successfully.', 'ok');
        form.reset();
        await refreshManufacturerProducts();
        await refreshDashboardSummary();
      });

      byId('manufacturerDeleteProductForm').addEventListener('submit', async function (event) {
        event.preventDefault();
        const productId = Number(event.target.product_id.value);
        const res = await api('/product/' + productId, 'DELETE');
        if (!res.ok) {
          setMessage('manufacturerProductMessage', getErrorMessage(res, 'Failed to remove product.'), 'err');
          return;
        }
        setMessage('manufacturerProductMessage', 'Product removed successfully.', 'ok');
        event.target.reset();
        await refreshManufacturerProducts();
        await refreshDashboardSummary();
      });

      byId('manufacturerRefreshProductsBtn').addEventListener('click', async function () {
        await refreshManufacturerProducts();
        setMessage('manufacturerProductMessage', 'Product list refreshed.', 'ok');
      });

      byId('manufacturerAddPartsForm').addEventListener('submit', async function (event) {
        event.preventDefault();
        const form = event.target;
        const res = await api('/parts', 'POST', {
          name: form.name.value.trim(),
          stock_qty: Number(form.stock_qty.value),
        });

        if (!res.ok) {
          setMessage('manufacturerPartsMessage', getErrorMessage(res, 'Failed to add parts.'), 'err');
          return;
        }
        setMessage('manufacturerPartsMessage', 'Parts added successfully.', 'ok');
        form.reset();
        await refreshManufacturerParts();
        await refreshDashboardSummary();
      });

      byId('manufacturerDeletePartsForm').addEventListener('submit', async function (event) {
        event.preventDefault();
        const partId = Number(event.target.part_id.value);
        const res = await api('/parts/' + partId, 'DELETE');
        if (!res.ok) {
          setMessage('manufacturerPartsMessage', getErrorMessage(res, 'Failed to remove parts.'), 'err');
          return;
        }
        setMessage('manufacturerPartsMessage', 'Parts removed successfully.', 'ok');
        event.target.reset();
        await refreshManufacturerParts();
        await refreshDashboardSummary();
      });

      byId('manufacturerRefreshPartsBtn').addEventListener('click', async function () {
        await refreshManufacturerParts();
        setMessage('manufacturerPartsMessage', 'Parts list refreshed.', 'ok');
      });

      byId('manufacturerCreatePoForm').addEventListener('submit', async function (event) {
        event.preventDefault();
        const form = event.target;
        const payload = {
          supplier_id: Number(form.supplier_id.value),
          part_id: Number(form.part_id.value),
          quantity: Number(form.quantity.value),
        };

        const soInput = form.sales_order_id.value.trim();
        const prodInput = form.product_id.value.trim();
        if (soInput) {
          payload.sales_order_id = Number(soInput);
        }
        if (prodInput) {
          payload.product_id = Number(prodInput);
        }

        const res = await api('/purchase-order', 'POST', payload);
        if (!res.ok) {
          setMessage('manufacturerPoMessage', getErrorMessage(res, 'Failed to create purchase order.'), 'err');
          return;
        }

        const po = res.data.purchase_order;
        setMessage(
          'manufacturerPoMessage',
          'Purchase order created successfully (PO ID: ' + po.po_id + ', Status: ' + po.status + ').',
          'ok'
        );
        form.reset();
        form.supplier_id.value = '1';
        await refreshDashboardSummary();
      });

      byId('manufacturerRefreshInventoryBtn').addEventListener('click', async function () {
        await refreshManufacturerInventory();
      });

      byId('supplierQuotationForm').addEventListener('submit', async function (event) {
        event.preventDefault();
        const form = event.target;
        const payload = {
          supplier_id: Number(form.supplier_id.value),
          part_id: Number(form.part_id.value),
          price: Number(form.price.value),
        };
        const res = await api('/quotation', 'POST', payload);
        if (!res.ok) {
          setMessage('supplierMessage', getErrorMessage(res, 'Quotation submission failed.'), 'err');
          return;
        }
        setMessage('supplierMessage', 'Quotation submitted successfully.', 'ok');
        form.reset();
        form.supplier_id.value = '1';
      });

      byId('supplierRefreshPoBtn').addEventListener('click', async function () {
        await refreshSupplierPurchaseOrders();
        setMessage('supplierMessage', 'Purchase order list refreshed.', 'ok');
      });

      showLoginPage();
      resetSections();
    </script>
  </body>
</html>`);
});

app.post("/register", async (req, res) => {
  try {
    const { name, role, password } = req.body || {};
    if (!name || !role || !password) {
      res.status(400).json({ error: "name, role and password are required" });
      return;
    }

    const allowedRoles = ["DEALER", "MANUFACTURER", "SUPPLIER"];
    if (!allowedRoles.includes(String(role).toUpperCase())) {
      res.status(400).json({ error: `role must be one of ${allowedRoles.join(", ")}` });
      return;
    }

    const insert = await run("INSERT INTO User (name, role, password) VALUES (?, ?, ?)", [
      String(name).trim(),
      String(role).toUpperCase(),
      String(password),
    ]);

    const user = await get("SELECT user_id, name, role FROM User WHERE user_id = ?", [insert.lastID]);
    res.status(201).json({ message: "User registered", user });
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      res.status(409).json({ error: "User name already exists" });
      return;
    }
    res.status(500).json({ error: err.message });
  }
});

app.post("/login", async (req, res) => {
  try {
    const { name, password } = req.body || {};
    if (!name || !password) {
      res.status(400).json({ error: "name and password are required" });
      return;
    }

    const user = await get(
      "SELECT user_id, name, role FROM User WHERE name = ? AND password = ?",
      [String(name), String(password)]
    );

    if (!user) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }

    res.json({ message: "Login successful", user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/product", async (req, res) => {
  try {
    const { name, stock_qty } = req.body || {};
    const qty = toNonNegativeInt(stock_qty);
    if (!name || qty === null) {
      res.status(400).json({ error: "name and non-negative integer stock_qty are required" });
      return;
    }

    const insert = await run("INSERT INTO Product (name, stock_qty) VALUES (?, ?)", [String(name).trim(), qty]);
    const product = await get("SELECT * FROM Product WHERE product_id = ?", [insert.lastID]);
    res.status(201).json({ message: "Product added", product });
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      res.status(409).json({ error: "Product name already exists" });
      return;
    }
    res.status(500).json({ error: err.message });
  }
});

app.delete("/product/:id", async (req, res) => {
  try {
    const id = toPositiveInt(req.params.id);
    if (!id) {
      res.status(400).json({ error: "Invalid product id" });
      return;
    }

    const del = await run("DELETE FROM Product WHERE product_id = ?", [id]);
    if (!del.changes) {
      res.status(404).json({ error: "Product not found" });
      return;
    }

    res.json({ message: "Product removed", product_id: id });
  } catch (err) {
    if (String(err.message).includes("FOREIGN KEY")) {
      res.status(409).json({ error: "Cannot delete product referenced by orders" });
      return;
    }
    res.status(500).json({ error: err.message });
  }
});

app.get("/products", async (req, res) => {
  try {
    const products = await all("SELECT * FROM Product ORDER BY product_id");
    res.json({ products });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/parts", async (req, res) => {
  try {
    const { name, stock_qty } = req.body || {};
    const qty = toNonNegativeInt(stock_qty);
    if (!name || qty === null) {
      res.status(400).json({ error: "name and non-negative integer stock_qty are required" });
      return;
    }

    const insert = await run("INSERT INTO Parts (name, stock_qty) VALUES (?, ?)", [String(name).trim(), qty]);
    const part = await get("SELECT * FROM Parts WHERE part_id = ?", [insert.lastID]);
    res.status(201).json({ message: "Part added", part });
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      res.status(409).json({ error: "Part name already exists" });
      return;
    }
    res.status(500).json({ error: err.message });
  }
});

app.delete("/parts/:id", async (req, res) => {
  try {
    const id = toPositiveInt(req.params.id);
    if (!id) {
      res.status(400).json({ error: "Invalid part id" });
      return;
    }

    const del = await run("DELETE FROM Parts WHERE part_id = ?", [id]);
    if (!del.changes) {
      res.status(404).json({ error: "Part not found" });
      return;
    }

    res.json({ message: "Part removed", part_id: id });
  } catch (err) {
    if (String(err.message).includes("FOREIGN KEY")) {
      res.status(409).json({ error: "Cannot delete part referenced by purchase orders/quotations" });
      return;
    }
    res.status(500).json({ error: err.message });
  }
});

app.get("/parts", async (req, res) => {
  try {
    const parts = await all("SELECT * FROM Parts ORDER BY part_id");
    res.json({ parts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/materials", async (req, res) => {
  try {
    const parts = await all("SELECT * FROM Parts ORDER BY part_id");
    res.json({ available_materials: parts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/order", async (req, res) => {
  try {
    const dealerId = toPositiveInt(req.body?.dealer_id);
    const productId = toPositiveInt(req.body?.product_id);
    const quantity = toPositiveInt(req.body?.quantity);

    if (!dealerId || !productId || !quantity) {
      res.status(400).json({ error: "dealer_id, product_id and positive integer quantity are required" });
      return;
    }

    const dealer = await ensureEntityExists("Dealer", "dealer_id", dealerId);
    if (!dealer) {
      res.status(404).json({ error: "Dealer not found" });
      return;
    }

    const product = await ensureEntityExists("Product", "product_id", productId);
    if (!product) {
      res.status(404).json({ error: "Product not found" });
      return;
    }

    if (product.stock_qty >= quantity) {
      await run("BEGIN TRANSACTION");
      let orderId;
      try {
        const orderInsert = await run(
          "INSERT INTO SalesOrder (dealer_id, product_id, quantity, status) VALUES (?, ?, ?, 'ACCEPTED')",
          [dealerId, productId, quantity]
        );
        orderId = orderInsert.lastID;

        const stockUpdate = await run(
          "UPDATE Product SET stock_qty = stock_qty - ? WHERE product_id = ? AND stock_qty >= ?",
          [quantity, productId, quantity]
        );
        if (!stockUpdate.changes) {
          throw new Error("Stock update failed for accepted order");
        }

        await run("INSERT INTO Invoice (so_id, total) VALUES (?, ?)", [orderId, quantity * FIXED_UNIT_PRICE]);

        await run("COMMIT");
      } catch (err) {
        await run("ROLLBACK");
        throw err;
      }

      const order = await get("SELECT * FROM SalesOrder WHERE so_id = ?", [orderId]);
      const invoice = await get("SELECT * FROM Invoice WHERE so_id = ?", [orderId]);

      res.status(201).json({
        message: "Order accepted from stock. Product stock reduced and invoice generated.",
        dfd_path: "sufficient_stock",
        order,
        invoice,
      });
      return;
    }

    const shortage = quantity - product.stock_qty;
    const firstSupplier = await get("SELECT * FROM Supplier ORDER BY supplier_id LIMIT 1");
    if (!firstSupplier) {
      res.status(400).json({ error: "No supplier available for automatic purchase order" });
      return;
    }

    await run("BEGIN TRANSACTION");
    let orderId;
    let poId;
    try {
      const orderInsert = await run(
        "INSERT INTO SalesOrder (dealer_id, product_id, quantity, status) VALUES (?, ?, ?, 'PENDING')",
        [dealerId, productId, quantity]
      );
      orderId = orderInsert.lastID;

      const poInsert = await run(
        `INSERT INTO PurchaseOrder (supplier_id, part_id, quantity, status, sales_order_id, product_id)
         VALUES (?, ?, ?, 'PENDING', ?, ?)`,
        [firstSupplier.supplier_id, productId, shortage, orderId, productId]
      );
      poId = poInsert.lastID;

      await run("COMMIT");
    } catch (err) {
      await run("ROLLBACK");
      throw err;
    }

    const order = await get("SELECT * FROM SalesOrder WHERE so_id = ?", [orderId]);
    const purchaseOrder = await get("SELECT * FROM PurchaseOrder WHERE po_id = ?", [poId]);

    res.status(201).json({
      message: "Stock shortage detected. Order is pending and purchase order created.",
      dfd_path: "shortage_detected",
      shortage,
      order,
      purchase_order: purchaseOrder,
      supplier: firstSupplier,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/order/:id/cancel", async (req, res) => {
  try {
    const orderId = toPositiveInt(req.params.id);
    if (!orderId) {
      res.status(400).json({ error: "Invalid order id" });
      return;
    }

    const order = await get("SELECT * FROM SalesOrder WHERE so_id = ?", [orderId]);
    if (!order) {
      res.status(404).json({ error: "Order not found" });
      return;
    }

    if (order.status === "CANCELLED") {
      res.json({ message: "Order already cancelled", order });
      return;
    }

    if (order.status === "COMPLETED") {
      res.status(400).json({ error: "Completed order cannot be cancelled" });
      return;
    }

    await run("BEGIN TRANSACTION");
    try {
      if (order.status === "ACCEPTED") {
        await run("UPDATE Product SET stock_qty = stock_qty + ? WHERE product_id = ?", [
          order.quantity,
          order.product_id,
        ]);
        await run("DELETE FROM Invoice WHERE so_id = ?", [order.so_id]);
      }

      await run(
        "UPDATE PurchaseOrder SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP WHERE sales_order_id = ? AND status = 'PENDING'",
        [orderId]
      );

      await run("UPDATE SalesOrder SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP WHERE so_id = ?", [
        orderId,
      ]);

      await run("COMMIT");
    } catch (err) {
      await run("ROLLBACK");
      throw err;
    }

    const updated = await get("SELECT * FROM SalesOrder WHERE so_id = ?", [orderId]);
    res.json({ message: "Order cancelled", order: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/order/:id", async (req, res) => {
  try {
    const orderId = toPositiveInt(req.params.id);
    if (!orderId) {
      res.status(400).json({ error: "Invalid order id" });
      return;
    }

    const order = await get(
      `SELECT so.*, d.name AS dealer_name, p.name AS product_name
       FROM SalesOrder so
       JOIN Dealer d ON d.dealer_id = so.dealer_id
       JOIN Product p ON p.product_id = so.product_id
       WHERE so.so_id = ?`,
      [orderId]
    );

    if (!order) {
      res.status(404).json({ error: "Order not found" });
      return;
    }

    const invoice = await get("SELECT * FROM Invoice WHERE so_id = ?", [orderId]);
    const purchaseOrders = await all("SELECT * FROM PurchaseOrder WHERE sales_order_id = ? ORDER BY po_id", [orderId]);

    res.json({ order, invoice, purchase_orders: purchaseOrders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/purchase-order", async (req, res) => {
  try {
    const supplierId = toPositiveInt(req.body?.supplier_id);
    const partId = toPositiveInt(req.body?.part_id);
    const quantity = toPositiveInt(req.body?.quantity);
    const salesOrderId = req.body?.sales_order_id ? toPositiveInt(req.body.sales_order_id) : null;
    const productId = req.body?.product_id ? toPositiveInt(req.body.product_id) : null;

    if (!supplierId || !partId || !quantity) {
      res.status(400).json({ error: "supplier_id, part_id and positive integer quantity are required" });
      return;
    }

    const supplier = await ensureEntityExists("Supplier", "supplier_id", supplierId);
    if (!supplier) {
      res.status(404).json({ error: "Supplier not found" });
      return;
    }

    const part = await ensureEntityExists("Parts", "part_id", partId);
    if (!part) {
      res.status(404).json({ error: "Part not found" });
      return;
    }

    if (salesOrderId) {
      const so = await ensureEntityExists("SalesOrder", "so_id", salesOrderId);
      if (!so) {
        res.status(404).json({ error: "sales_order_id not found" });
        return;
      }
    }

    if (productId) {
      const product = await ensureEntityExists("Product", "product_id", productId);
      if (!product) {
        res.status(404).json({ error: "product_id not found" });
        return;
      }
    }

    const insert = await run(
      `INSERT INTO PurchaseOrder (supplier_id, part_id, quantity, status, sales_order_id, product_id)
       VALUES (?, ?, ?, 'PENDING', ?, ?)`,
      [supplierId, partId, quantity, salesOrderId, productId]
    );

    const po = await get("SELECT * FROM PurchaseOrder WHERE po_id = ?", [insert.lastID]);
    res.status(201).json({ message: "Purchase order created", purchase_order: po });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/purchase-order/:id/respond", async (req, res) => {
  try {
    const poId = toPositiveInt(req.params.id);
    if (!poId) {
      res.status(400).json({ error: "Invalid purchase order id" });
      return;
    }

    const action = String(req.body?.action || "").toUpperCase();
    if (!["ACCEPT", "REJECT"].includes(action)) {
      res.status(400).json({ error: "action must be ACCEPT or REJECT" });
      return;
    }

    const po = await get("SELECT * FROM PurchaseOrder WHERE po_id = ?", [poId]);
    if (!po) {
      res.status(404).json({ error: "Purchase order not found" });
      return;
    }

    if (po.status !== "PENDING") {
      res.status(400).json({ error: `Purchase order is already ${po.status}` });
      return;
    }

    if (action === "REJECT") {
      await run("UPDATE PurchaseOrder SET status = 'REJECTED', updated_at = CURRENT_TIMESTAMP WHERE po_id = ?", [poId]);
      const updatedPo = await get("SELECT * FROM PurchaseOrder WHERE po_id = ?", [poId]);
      res.json({ message: "Purchase order rejected", purchase_order: updatedPo });
      return;
    }

    await run("BEGIN TRANSACTION");
    try {
      await run("UPDATE PurchaseOrder SET status = 'ACCEPTED', updated_at = CURRENT_TIMESTAMP WHERE po_id = ?", [poId]);
      await run("UPDATE Parts SET stock_qty = stock_qty + ? WHERE part_id = ?", [po.quantity, po.part_id]);
      await run("COMMIT");
    } catch (err) {
      await run("ROLLBACK");
      throw err;
    }

    let completion = null;
    if (po.sales_order_id) {
      completion = await tryCompletePendingOrder(po.sales_order_id);
    }

    const updatedPo = await get("SELECT * FROM PurchaseOrder WHERE po_id = ?", [poId]);
    res.json({
      message: "Purchase order accepted. Parts stock updated.",
      purchase_order: updatedPo,
      production_and_completion: completion,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/quotation", async (req, res) => {
  try {
    const supplierId = toPositiveInt(req.body?.supplier_id);
    const partId = toPositiveInt(req.body?.part_id);
    const price = Number(req.body?.price);

    if (!supplierId || !partId || !Number.isFinite(price) || price <= 0) {
      res.status(400).json({ error: "supplier_id, part_id and positive price are required" });
      return;
    }

    const supplier = await ensureEntityExists("Supplier", "supplier_id", supplierId);
    if (!supplier) {
      res.status(404).json({ error: "Supplier not found" });
      return;
    }

    const part = await ensureEntityExists("Parts", "part_id", partId);
    if (!part) {
      res.status(404).json({ error: "Part not found" });
      return;
    }

    const insert = await run("INSERT INTO Quotation (supplier_id, part_id, price) VALUES (?, ?, ?)", [
      supplierId,
      partId,
      price,
    ]);
    const quotation = await get("SELECT * FROM Quotation WHERE quote_id = ?", [insert.lastID]);
    res.status(201).json({ message: "Quotation stored", quotation });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/invoice/:order_id", async (req, res) => {
  try {
    const orderId = toPositiveInt(req.params.order_id);
    if (!orderId) {
      res.status(400).json({ error: "Invalid order id" });
      return;
    }

    const result = await createInvoiceIfAllowed(orderId);
    res.status(result.created ? 201 : 200).json({
      message: result.created ? "Invoice generated" : "Invoice already exists",
      invoice: result.invoice,
      fixed_unit_price: FIXED_UNIT_PRICE,
    });
  } catch (err) {
    if (err.code === "NOT_FOUND") {
      res.status(404).json({ error: err.message });
      return;
    }
    if (err.code === "INVALID_STATE") {
      res.status(400).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: err.message });
  }
});

app.get("/suppliers", async (req, res) => {
  try {
    const suppliers = await all("SELECT * FROM Supplier ORDER BY supplier_id");
    res.json({ suppliers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/inventory", async (req, res) => {
  try {
    const products = await all("SELECT * FROM Product ORDER BY product_id");
    const parts = await all("SELECT * FROM Parts ORDER BY part_id");
    const pendingOrders = await all(
      `SELECT so.so_id, so.product_id, p.name AS product_name, so.quantity, p.stock_qty,
              CASE WHEN so.quantity > p.stock_qty THEN so.quantity - p.stock_qty ELSE 0 END AS shortage
       FROM SalesOrder so
       JOIN Product p ON p.product_id = so.product_id
       WHERE so.status = 'PENDING'
       ORDER BY so.so_id`
    );

    res.json({
      products,
      parts,
      pending_shortages: pendingOrders,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use((err, req, res, next) => {
  res.status(500).json({ error: err.message || "Unexpected server error" });
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`WAMS server running at http://localhost:${PORT}`);
      console.log("Default seeded IDs: dealer_id=1, supplier_id=1");
    });
  })
  .catch((err) => {
    console.error("Failed to initialize DB:", err);
    process.exit(1);
  });