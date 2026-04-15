const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const multer = require('multer');
const csv = require('csv-parser');
const { Parser } = require('@json2csv/plainjs');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../frontend')));

// Rate limiting untuk keamanan
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 menit
    max: 100 // limit setiap IP 100 request per windowMs
});
app.use('/api/', limiter);

// Setup SQLite Database
const { Pool } = require('pg');

// Gunakan environment variable untuk keamanan
const pool = new Pool({
    connectionString: process.env.POSTGRES_URL + "?sslmode=require",
});

pool.connect((err) => {
    if (err) {
        console.error('Koneksi Postgres Error:', err.stack);
    } else {
        console.log('Terhubung ke Vercel Postgres');
    }
});

// Inisialisasi Tabel
function initDatabase() {
    db.run(`
        CREATE TABLE IF NOT EXISTS datasets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            description TEXT,
            file_path TEXT,
            is_active BOOLEAN DEFAULT 0,
            total_records INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            dataset_id INTEGER,
            user_id TEXT NOT NULL,
            nama TEXT NOT NULL,
            tanggal_lahir TEXT NOT NULL,
            posisi TEXT NOT NULL,
            divisi TEXT NOT NULL,
            pesan TEXT,
            is_revealed BOOLEAN DEFAULT 0,
            revealed_at DATETIME,
            FOREIGN KEY (dataset_id) REFERENCES datasets(id) ON DELETE CASCADE
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS admin_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            action TEXT NOT NULL,
            details TEXT,
            ip_address TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Index untuk performa
    db.run(`CREATE INDEX IF NOT EXISTS idx_records_lookup ON records(user_id, tanggal_lahir, dataset_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_active_dataset ON datasets(is_active)`);
}

// Setup Multer untuk upload CSV
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, 'uploads');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const timestamp = Date.now();
        cb(null, `dataset_${timestamp}.csv`);
    }
});

const upload = multer({ 
    storage: storage,
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
            cb(null, true);
        } else {
            cb(new Error('Hanya file CSV yang diperbolehkan'));
        }
    }
});

// ==================== ADMIN ENDPOINTS ====================

// Validasi Admin
function validateAdmin(req, res, next) {
    // Coba ambil dari body (JSON) atau dari form fields (FormData)
    const admin_id = req.body.admin_id || req.body['admin_id'];
    const admin_date = req.body.admin_date || req.body['admin_date'];
    
    console.log('🔐 Validating admin:', { admin_id, admin_date }); // Debug log
    
    if (admin_id === '090006' && admin_date === '1976/02/14') {
        next();
    } else {
        console.log('❌ Invalid credentials received:', { admin_id, admin_date });
        res.status(403).json({ error: 'Akses ditolak. Kredensial admin tidak valid.' });
    }
}

// Upload CSV Dataset
app.post('/api/admin/upload', upload.single('csv'), (req, res, next) => {
    // Validasi manual setelah multer memproses form data
    const admin_id = req.body.admin_id;
    const admin_date = req.body.admin_date;
    
    console.log('📤 Upload attempt:', { admin_id, admin_date, file: req.file?.originalname });
    
    if (admin_id !== '090006' || admin_date !== '1976/02/14') {
        // Hapus file yang sudah terupload jika validasi gagal
        if (req.file && req.file.path && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
        return res.status(403).json({ error: 'Akses ditolak. Kredensial admin tidak valid.' });
    }
    
    // Lanjutkan ke logic upload
    if (!req.file) {
        return res.status(400).json({ error: 'File CSV diperlukan' });
    }

    const { name, description } = req.body;
    const results = [];
    let recordCount = 0;

    fs.createReadStream(req.file.path)
        .pipe(csv())
        .on('data', (data) => {
            const normalized = {};
            Object.keys(data).forEach(key => {
                const cleanKey = key.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
                normalized[cleanKey] = data[key].trim();
            });
            results.push(normalized);
        })
        .on('end', () => {
            db.run(
                `INSERT INTO datasets (name, description, file_path, total_records) 
                 VALUES (?, ?, ?, ?)`,
                [name || 'Dataset Baru', description || '', req.file.path, results.length],
                function(err) {
                    if (err) {
                        return res.status(500).json({ error: err.message });
                    }
                    
                    const datasetId = this.lastID;
                    
                    const stmt = db.prepare(`
                        INSERT INTO records 
                        (dataset_id, user_id, nama, tanggal_lahir, posisi, divisi, pesan) 
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                    `);

                    results.forEach(row => {
                        const userId = row.id || row.user_id || row.nomor || row.no || '';
                        const nama = row.nama || row.name || row.nama_lengkap || '';
                        const tgl = row.tanggal_lahir || row.tgl_lahir || row.dob || row.birth_date || '';
                        const posisi = row.posisi || row.position || row.jabatan || '';
                        const divisi = row.divisi || row.division || row.department || row.dept || '';
                        const pesan = row.pesan || row.message || row.notes || 'Selamat atas pencapaian Anda!';

                        if (userId && nama && tgl) {
                            stmt.run(datasetId, userId, nama, tgl, posisi, divisi, pesan);
                            recordCount++;
                        }
                    });

                    stmt.finalize();

                    db.run(
                        `INSERT INTO admin_logs (action, details, ip_address) 
                         VALUES (?, ?, ?)`,
                        ['UPLOAD_DATASET', `Dataset: ${name}, Records: ${recordCount}`, req.ip]
                    );

                    res.json({
                        success: true,
                        message: `Dataset berhasil diupload dengan ${recordCount} records`,
                        dataset_id: datasetId,
                        total_records: recordCount
                    });
                }
            );
        })
        .on('error', (err) => {
            res.status(500).json({ error: 'Error parsing CSV: ' + err.message });
        });
});

// Get All Datasets
app.post('/api/admin/datasets', validateAdmin, (req, res) => {
    db.all(
        `SELECT d.*, 
                (SELECT COUNT(*) FROM records WHERE dataset_id = d.id) as actual_count
         FROM datasets d 
         ORDER BY d.created_at DESC`,
        [],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows);
        }
    );
});

// Set Active Dataset (hanya satu yang aktif)
app.post('/api/admin/activate', validateAdmin, (req, res) => {
    const { dataset_id, admin_id, admin_date } = req.body;
    
    db.serialize(() => {
        // Deactivate all
        db.run(`UPDATE datasets SET is_active = 0, updated_at = CURRENT_TIMESTAMP`);
        
        // Activate selected
        db.run(
            `UPDATE datasets SET is_active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [dataset_id],
            function(err) {
                if (err) return res.status(500).json({ error: err.message });
                
                if (this.changes === 0) {
                    return res.status(404).json({ error: 'Dataset tidak ditemukan' });
                }

                // Log
                db.run(
                    `INSERT INTO admin_logs (action, details, ip_address) 
                     VALUES (?, ?, ?)`,
                    ['ACTIVATE_DATASET', `Dataset ID: ${dataset_id}`, req.ip]
                );

                res.json({ 
                    success: true, 
                    message: `Dataset ${dataset_id} sekarang aktif di server` 
                });
            }
        );
    });
});

// Delete Dataset
app.post('/api/admin/delete', validateAdmin, (req, res) => {
    const { dataset_id, admin_id, admin_date } = req.body;
    
    // Get file path first
    db.get(`SELECT file_path FROM datasets WHERE id = ?`, [dataset_id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        
        // Delete from database (cascade akan hapus records)
        db.run(`DELETE FROM datasets WHERE id = ?`, [dataset_id], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            
            // Delete file if exists
            if (row && row.file_path && fs.existsSync(row.file_path)) {
                fs.unlinkSync(row.file_path);
            }

            db.run(
                `INSERT INTO admin_logs (action, details, ip_address) 
                 VALUES (?, ?, ?)`,
                ['DELETE_DATASET', `Dataset ID: ${dataset_id}`, req.ip]
            );

            res.json({ success: true, message: 'Dataset berhasil dihapus' });
        });
    });
});

// Download Template CSV
app.get('/api/admin/template', (req, res) => {
    const fields = ['ID', 'Nama', 'Tanggal_Lahir', 'Posisi', 'Divisi', 'Pesan'];
    const data = [
        { ID: '001', Nama: 'Budi Santoso', Tanggal_Lahir: '2000/05/15', Posisi: 'Staff IT', Divisi: 'IT', Pesan: 'Selamat bergabung!' },
        { ID: '002', Nama: 'Ani Wijaya', Tanggal_Lahir: '1999/08/22', Posisi: 'Manager', Divisi: 'Marketing', Pesan: 'Welcome to the team!' }
    ];
    
    const parser = new Parser({ fields });
    const csv = parser.parse(data);
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="template_reveal_card.csv"');
    res.send(csv);
});

// Get Admin Logs
app.post('/api/admin/logs', validateAdmin, (req, res) => {
    db.all(
        `SELECT * FROM admin_logs ORDER BY timestamp DESC LIMIT 100`,
        [],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows);
        }
    );
});

// ==================== CLIENT ENDPOINTS ====================

// Get Active Dataset Info (public)
app.get('/api/client/active-info', (req, res) => {
    db.get(
        `SELECT id, name, description, total_records, updated_at 
         FROM datasets WHERE is_active = 1`,
        [],
        (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!row) return res.status(404).json({ error: 'Tidak ada dataset aktif' });
            res.json(row);
        }
    );
});

// Check User Data
app.post('/api/client/check', (req, res) => {
    const { user_id, tanggal_lahir } = req.body;
    
    if (!user_id || !tanggal_lahir) {
        return res.status(400).json({ error: 'ID dan Tanggal Lahir diperlukan' });
    }

    // Format tanggal untuk handle berbagai input (YYYY/MM/DD atau YYYY-MM-DD)
    const formattedDate = tanggal_lahir.replace(/-/g, '/');

    db.get(
        `SELECT r.* FROM records r
         JOIN datasets d ON r.dataset_id = d.id
         WHERE d.is_active = 1 
         AND r.user_id = ? 
         AND (r.tanggal_lahir = ? OR r.tanggal_lahir = ?)`,
        [user_id, tanggal_lahir, formattedDate],
        (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            
            if (!row) {
                return res.status(404).json({ 
                    error: 'Data tidak ditemukan. Periksa ID dan Tanggal Lahir Anda.' 
                });
            }

            // Update revealed status
            if (!row.is_revealed) {
                db.run(
                    `UPDATE records SET is_revealed = 1, revealed_at = CURRENT_TIMESTAMP 
                     WHERE id = ?`,
                    [row.id]
                );
            }

            res.json({
                found: true,
                data: {
                    nama: row.nama,
                    user_id: row.user_id,
                    posisi: row.posisi,
                    divisi: row.divisi,
                    pesan: row.pesan,
                    is_revealed: row.is_revealed || false
                }
            });
        }
    );
});

// Get Stats (public)
app.get('/api/client/stats', (req, res) => {
    db.get(
        `SELECT 
            (SELECT COUNT(*) FROM records WHERE dataset_id = d.id) as total,
            (SELECT COUNT(*) FROM records WHERE dataset_id = d.id AND is_revealed = 1) as revealed
         FROM datasets d WHERE d.is_active = 1`,
        [],
        (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(row || { total: 0, revealed: 0 });
        }
    );
});

// ==================== START SERVER ====================

app.listen(PORT, () => {
    console.log(`
    ╔══════════════════════════════════════════════════╗
    ║     🚀 REVEAL CARD SERVER STARTED                 ║
    ║                                                  ║
    ║     Local:   http://localhost:${PORT}              ║
    ║     Admin:   http://localhost:${PORT}/manuel.html   ║
    ║     Client:  http://localhost:${PORT}/index.html  ║
    ║                                                  ║
    ║     Admin ID:     090006                          ║
    ║     Admin Date:   1976/02/14                      ║
    ╚══════════════════════════════════════════════════╝
    `);
});

// Graceful shutdown
process.on('SIGINT', () => {
    db.close((err) => {
        if (err) console.error(err.message);
        console.log('\n👋 Database connection closed.');
        process.exit(0);
    });
});