const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const session = require('express-session');
const crypto = require('crypto');
const path = require('path');
const multer = require('multer'); // Для загрузки картинок

const app = express();
const PORT = 3000;

// Настройка multer для загрузки файлов
const storage = multer.diskStorage({
    destination: './public/uploads/',
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage });

// Создаем папку для загрузок, если её нет
const fs = require('fs');
if (!fs.existsSync('./public/uploads')) {
    fs.mkdirSync('./public/uploads', { recursive: true });
}

const db = new sqlite3.Database('./shop.db');

function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
    return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
    const [salt, hash] = stored.split(':');
    const verifyHash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
    return hash === verifyHash;
}

db.serialize(() => {
    // Таблицы
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        username TEXT UNIQUE, 
        password TEXT,
        is_admin INTEGER DEFAULT 0
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT, price REAL, description TEXT, image TEXT
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS cart (
        user_id INTEGER,
        product_id INTEGER,
        quantity INTEGER,
        PRIMARY KEY (user_id, product_id),
        FOREIGN KEY(user_id) REFERENCES users(id),
        FOREIGN KEY(product_id) REFERENCES products(id)
    )`);
    
    // Товары
    db.get("SELECT COUNT(*) as count FROM products", (err, row) => {
        if (row.count === 0) {
            const stmt = db.prepare("INSERT INTO products (name, price, description, image) VALUES (?, ?, ?, ?)");
            stmt.run('Ноутбук', 50000, 'Мощный ноутбук для работы и игр', 'https://images.unsplash.com/photo-1496181133206-80ce9b88a853?w=400');
            stmt.run('Смартфон', 30000, 'Флагманский смартфон с хорошей камерой', 'https://images.unsplash.com/photo-1511707171634-5f897ff02aa9?w=400');
            stmt.run('Наушники', 5000, 'Беспроводные наушники с шумоподавлением', 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=400');
            stmt.run('Клавиатура', 3000, 'Механическая клавиатура с подсветкой', 'https://images.unsplash.com/photo-1587829741301-dc798b83add3?w=400');
            stmt.finalize();
        }
    });
    
    // Создаем админа, если его нет
    db.get("SELECT * FROM users WHERE is_admin = 1", (err, row) => {
        if (!row) {
            const hashed = hashPassword('admin123');
            db.run("INSERT INTO users (username, password, is_admin) VALUES (?, ?, 1)", ['admin', hashed]);
        }
    });
});

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
    secret: 'super_secret_key_123',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false }
}));

// Middleware
app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    res.locals.isAdmin = req.session.isAdmin || false;
    res.locals.messages = req.session.messages || [];
    req.session.messages = [];

    if (req.session.userId) {
        db.get("SELECT SUM(quantity) as total FROM cart WHERE user_id = ?", [req.session.userId], (err, row) => {
            res.locals.cartCount = row && row.total ? row.total : 0;
            next();
        });
    } else {
        res.locals.cartCount = 0;
        next();
    }
});

// Проверка на админа
const isAdmin = (req, res, next) => {
    if (req.session.isAdmin) return next();
    req.session.messages = [{ type: 'danger', text: 'Доступ запрещен!' }];
    res.redirect('/');
};

// Главная
app.get('/', (req, res) => {
    db.all("SELECT * FROM products", [], (err, products) => {
        res.render('index', { products });
    });
});

// --- КОРЗИНА ---
app.get('/add_to_cart/:id', (req, res) => {
    if (!req.session.userId) {
        req.session.messages = [{ type: 'warning', text: 'Войдите, чтобы добавить товар!' }];
        return res.redirect('/login');
    }
    
    const productId = req.params.id;
    const userId = req.session.userId;

    db.get("SELECT quantity FROM cart WHERE user_id = ? AND product_id = ?", [userId, productId], (err, row) => {
        if (row) {
            db.run("UPDATE cart SET quantity = quantity + 1 WHERE user_id = ? AND product_id = ?", [userId, productId]);
        } else {
            db.run("INSERT INTO cart (user_id, product_id, quantity) VALUES (?, ?, 1)", [userId, productId]);
        }
        req.session.messages = [{ type: 'success', text: 'Товар добавлен!' }];
        res.redirect('/');
    });
});

app.get('/update_cart/:id/:action', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    
    const productId = req.params.id;
    const action = req.params.action;
    const userId = req.session.userId;

    db.get("SELECT quantity FROM cart WHERE user_id = ? AND product_id = ?", [userId, productId], (err, row) => {
        if (row) {
            let newQty = row.quantity;
            if (action === 'inc') newQty++;
            if (action === 'dec') newQty--;

            if (newQty <= 0) {
                db.run("DELETE FROM cart WHERE user_id = ? AND product_id = ?", [userId, productId]);
            } else {
                db.run("UPDATE cart SET quantity = ? WHERE user_id = ? AND product_id = ?", [newQty, userId, productId]);
            }
        }
        res.redirect('/cart');
    });
});

app.get('/cart', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    
    const userId = req.session.userId;
    const query = `
        SELECT products.*, cart.quantity 
        FROM cart 
        JOIN products ON cart.product_id = products.id 
        WHERE cart.user_id = ?
    `;
    
    db.all(query, [userId], (err, items) => {
        let total = 0;
        items.forEach(item => {
            item.sum = item.price * item.quantity;
            total += item.sum;
        });
        res.render('cart', { items, total });
    });
});

app.get('/remove_from_cart/:id', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    db.run("DELETE FROM cart WHERE user_id = ? AND product_id = ?", [req.session.userId, req.params.id]);
    res.redirect('/cart');
});

// --- АДМИН ПАНЕЛЬ ---
app.get('/admin', isAdmin, (req, res) => {
    db.all("SELECT * FROM products", [], (err, products) => {
        res.render('admin', { products });
    });
});

// Добавление товара
app.get('/admin/add', isAdmin, (req, res) => {
    res.render('admin_edit', { product: null, action: 'add' });
});

app.post('/admin/add', isAdmin, upload.single('imageFile'), (req, res) => {
    const { name, price, description, imageUrl } = req.body;
    const image = req.file ? `/uploads/${req.file.filename}` : imageUrl;
    
    db.run("INSERT INTO products (name, price, description, image) VALUES (?, ?, ?, ?)", 
        [name, price, description, image], (err) => {
        req.session.messages = [{ type: 'success', text: 'Товар добавлен!' }];
        res.redirect('/admin');
    });
});

// Редактирование товара
app.get('/admin/edit/:id', isAdmin, (req, res) => {
    db.get("SELECT * FROM products WHERE id = ?", [req.params.id], (err, product) => {
        if (!product) return res.redirect('/admin');
        res.render('admin_edit', { product, action: 'edit' });
    });
});

app.post('/admin/edit/:id', isAdmin, upload.single('imageFile'), (req, res) => {
    const { name, price, description, imageUrl } = req.body;
    const id = req.params.id;
    
    db.get("SELECT image FROM products WHERE id = ?", [id], (err, row) => {
        const image = req.file ? `/uploads/${req.file.filename}` : (imageUrl || row.image);
        
        db.run("UPDATE products SET name = ?, price = ?, description = ?, image = ? WHERE id = ?", 
            [name, price, description, image, id], (err) => {
            req.session.messages = [{ type: 'success', text: 'Товар обновлён!' }];
            res.redirect('/admin');
        });
    });
});

// Удаление товара
app.get('/admin/delete/:id', isAdmin, (req, res) => {
    db.run("DELETE FROM products WHERE id = ?", [req.params.id]);
    db.run("DELETE FROM cart WHERE product_id = ?", [req.params.id]); // Удаляем из корзин
    req.session.messages = [{ type: 'success', text: 'Товар удалён!' }];
    res.redirect('/admin');
});

// --- АВТОРИЗАЦИЯ ---
app.get('/register', (req, res) => res.render('auth', { title: 'Регистрация', action: 'register' }));
app.post('/register', (req, res) => {
    const { username, password } = req.body;
    const hashed = hashPassword(password);
    db.run("INSERT INTO users (username, password) VALUES (?, ?)", [username, hashed], (err) => {
        if (err) {
            req.session.messages = [{ type: 'danger', text: 'Пользователь уже существует' }];
            return res.redirect('/register');
        }
        req.session.messages = [{ type: 'success', text: 'Регистрация успешна! Войдите.' }];
        res.redirect('/login');
    });
});

app.get('/login', (req, res) => res.render('auth', { title: 'Вход', action: 'login' }));
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    db.get("SELECT * FROM users WHERE username = ?", [username], (err, user) => {
        if (!user || !verifyPassword(password, user.password)) {
            req.session.messages = [{ type: 'danger', text: 'Неверный логин или пароль' }];
            return res.redirect('/login');
        }
        req.session.user = user.username;
        req.session.userId = user.id;
        req.session.isAdmin = user.is_admin === 1;
        req.session.messages = [{ type: 'success', text: 'С возвращением!' }];
        res.redirect('/');
    });
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

app.listen(PORT, () => console.log(`Сервер: http://localhost:${PORT}`));