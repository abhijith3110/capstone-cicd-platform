CREATE TABLE IF NOT EXISTS items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL
);



INSERT INTO items (name) VALUES ('Sample Item 1'), ('Sample Item 2'), ('Sample Item 3');
