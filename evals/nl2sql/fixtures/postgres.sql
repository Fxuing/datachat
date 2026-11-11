-- Deterministic fixture for the NL2SQL golden set. Keep in sync with mysql.sql.
DROP TABLE IF EXISTS order_items;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS customers;

CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  name VARCHAR(50) NOT NULL,
  city VARCHAR(30) NOT NULL,
  segment VARCHAR(20) NOT NULL,
  created_at TIMESTAMP NOT NULL
);

CREATE TABLE products (
  id INTEGER PRIMARY KEY,
  name VARCHAR(50) NOT NULL,
  category VARCHAR(30) NOT NULL,
  price NUMERIC(10, 2) NOT NULL
);

CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers (id),
  status VARCHAR(20) NOT NULL,
  created_at TIMESTAMP NOT NULL,
  total_amount NUMERIC(12, 2) NOT NULL
);

CREATE TABLE order_items (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders (id),
  product_id INTEGER NOT NULL REFERENCES products (id),
  quantity INTEGER NOT NULL,
  unit_price NUMERIC(10, 2) NOT NULL
);

INSERT INTO customers (id, name, city, segment, created_at) VALUES
  (1, 'Alice', 'Shanghai', 'enterprise', '2024-01-10 09:00:00'),
  (2, 'Bob', 'Beijing', 'smb', '2024-02-15 09:00:00'),
  (3, 'Carol', 'Shanghai', 'smb', '2024-03-20 09:00:00'),
  (4, 'David', 'Shenzhen', 'enterprise', '2024-04-05 09:00:00'),
  (5, 'Eve', 'Beijing', 'consumer', '2024-05-12 09:00:00'),
  (6, 'Frank', 'Hangzhou', 'smb', '2024-06-18 09:00:00'),
  (7, 'Grace', 'Shanghai', 'consumer', '2024-07-22 09:00:00'),
  (8, 'Heidi', 'Shenzhen', 'enterprise', '2024-08-30 09:00:00'),
  (9, 'Ivan', 'Hangzhou', 'consumer', '2024-09-14 09:00:00'),
  (10, 'Judy', 'Beijing', 'enterprise', '2024-10-01 09:00:00'),
  (11, 'Ken', 'Guangzhou', 'consumer', '2024-11-11 09:00:00');

INSERT INTO products (id, name, category, price) VALUES
  (1, 'Widget A', 'Electronics', 100.00),
  (2, 'Widget B', 'Electronics', 150.00),
  (3, 'Gadget C', 'Electronics', 200.00),
  (4, 'Chair', 'Home', 80.00),
  (5, 'Desk', 'Home', 300.00),
  (6, 'Lamp', 'Home', 40.00),
  (7, 'Notebook', 'Office', 20.00),
  (8, 'Pen', 'Office', 5.00);

INSERT INTO orders (id, customer_id, status, created_at, total_amount) VALUES
  (1, 1, 'completed', '2025-01-05 10:00:00', 120.00),
  (2, 2, 'completed', '2025-01-18 11:30:00', 80.00),
  (3, 1, 'completed', '2025-02-02 09:15:00', 300.00),
  (4, 3, 'cancelled', '2025-02-14 15:40:00', 150.00),
  (5, 4, 'completed', '2025-02-20 13:10:00', 400.00),
  (6, 2, 'completed', '2025-03-03 10:05:00', 60.00),
  (7, 5, 'completed', '2025-03-15 16:20:00', 200.00),
  (8, 1, 'completed', '2025-03-28 09:45:00', 90.00),
  (9, 6, 'cancelled', '2025-04-04 14:30:00', 500.00),
  (10, 7, 'completed', '2025-04-19 11:00:00', 75.00),
  (11, 8, 'completed', '2025-05-06 10:10:00', 250.00),
  (12, 3, 'completed', '2025-05-21 17:25:00', 180.00),
  (13, 9, 'completed', '2025-06-01 09:30:00', 45.00),
  (14, 10, 'completed', '2025-06-17 15:00:00', 600.00),
  (15, 1, 'completed', '2025-07-09 12:40:00', 130.00),
  (16, 4, 'cancelled', '2025-07-23 10:20:00', 220.00),
  (17, 5, 'completed', '2025-08-11 14:10:00', 95.00),
  (18, 6, 'completed', '2025-09-08 11:50:00', 310.00),
  (19, 7, 'completed', '2025-10-02 16:05:00', 160.00),
  (20, 8, 'completed', '2025-12-20 10:30:00', 280.00);

INSERT INTO order_items (id, order_id, product_id, quantity, unit_price) VALUES
  (1, 1, 1, 1, 100.00),
  (2, 1, 7, 1, 20.00),
  (3, 2, 4, 1, 80.00),
  (4, 3, 3, 1, 200.00),
  (5, 3, 1, 1, 100.00),
  (6, 4, 2, 1, 150.00),
  (7, 5, 5, 1, 300.00),
  (8, 5, 7, 5, 20.00),
  (9, 6, 6, 1, 40.00),
  (10, 6, 8, 4, 5.00),
  (11, 7, 2, 1, 150.00),
  (12, 7, 8, 10, 5.00),
  (13, 8, 7, 1, 20.00),
  (14, 8, 8, 14, 5.00),
  (15, 9, 5, 1, 300.00),
  (16, 9, 3, 1, 200.00),
  (17, 10, 6, 1, 40.00),
  (18, 10, 7, 1, 20.00),
  (19, 10, 8, 3, 5.00),
  (20, 11, 3, 1, 200.00),
  (21, 11, 8, 10, 5.00),
  (22, 12, 2, 1, 150.00),
  (23, 12, 7, 1, 20.00),
  (24, 12, 8, 2, 5.00),
  (25, 13, 6, 1, 40.00),
  (26, 13, 8, 1, 5.00),
  (27, 14, 5, 2, 300.00),
  (28, 15, 1, 1, 100.00),
  (29, 15, 7, 1, 20.00),
  (30, 15, 8, 2, 5.00),
  (31, 16, 3, 1, 200.00),
  (32, 16, 7, 1, 20.00),
  (33, 17, 6, 1, 40.00),
  (34, 17, 7, 1, 20.00),
  (35, 17, 8, 7, 5.00),
  (36, 18, 3, 1, 200.00),
  (37, 18, 1, 1, 100.00),
  (38, 18, 8, 2, 5.00),
  (39, 19, 2, 1, 150.00),
  (40, 19, 8, 2, 5.00),
  (41, 20, 4, 1, 80.00),
  (42, 20, 3, 1, 200.00);
