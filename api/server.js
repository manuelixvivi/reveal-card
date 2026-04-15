const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const multer = require('multer');
const csv = require('csv-parser');
const { Parser } = require('@json2csv/plainjs');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const pool = new Pool({
    connectionString: process.env.POSTGRES_URL + "?sslmode=require",
});

pool.on('error', (err) => {
    console.error('Unexpected error on idle client', err);
});
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100
});
app.use('/api/', limiter);

const upload = multer({ dest: '/tmp/' });

app.post('/api/admin/login', (req, res) => {
    const { adminId, adminDate } = req.body;
    if (adminId === '090006' && adminDate === '1976/02/14') {
        res.json({ success: true });
    } else {
        res.status(401).json({ success: false, message: "Kredensial salah" });
    }
});

app.post('/api/admin/import', upload.single('csvFile'), async (req, res) => {
    const datasetName = req.body.datasetName || 'Untitled Dataset';
    const results = [];

    if (!req.file) return res.status(400).json({ error: 'Tidak ada file diunggah' });

    fs.createReadStream(req.file.path)
        .pipe(csv())
        .on('data', (data) => results.push(data))
        .on('end', async () => {
            try {
                await pool.query('UPDATE datasets SET is_active = 0');
                
                const datasetRes = await pool.query(
                    'INSERT INTO datasets (name, is_active) VALUES ($1, 1) RETURNING id',
                    [datasetName]
                );
                const datasetId = datasetRes.rows[0].id;

                for (const row of results) {
                    await pool.query(
                        `INSERT INTO records 
                        (dataset_id, nim, name, birth_date, position, division, note) 
                        VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                        [datasetId, row.nim, row.name, row.birth_date, row.position, row.division, row.note]
                    );
                }
                res.json({ success: true, message: `${results.length} data berhasil diimport` });
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        });
});

app.get('/api/client/stats', async (req, res) => {
    try {
        const query = `
            SELECT 
                (SELECT COUNT(*) FROM records WHERE dataset_id = d.id) as total,
                (SELECT COUNT(*) FROM records WHERE dataset_id = d.id AND is_revealed = 1) as revealed
            FROM datasets d WHERE d.is_active = 1 LIMIT 1`;
        const stats = await pool.query(query);
        res.json(stats.rows[0] || { total: 0, revealed: 0 });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/client/reveal', async (req, res) => {
    const { nim, birth_date } = req.body;
    try {
        const query = `
            SELECT r.* FROM records r 
            JOIN datasets d ON r.dataset_id = d.id 
            WHERE d.is_active = 1 AND r.nim = $1 AND r.birth_date = $2`;
        
        const result = await pool.query(query, [nim, birth_date]);
        const row = result.rows[0];

        if (row) {
            if (row.is_revealed === 0) {
                await pool.query(
                    'UPDATE records SET is_revealed = 1, revealed_at = CURRENT_TIMESTAMP WHERE id = $1',
                    [row.id]
                );
            }
            res.json({ success: true, data: row });
        } else {
            res.status(404).json({ success: false, message: "Data tidak ditemukan atau tanggal lahir salah" });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/export', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT r.nim, r.name, r.is_revealed, r.revealed_at 
            FROM records r 
            JOIN datasets d ON r.dataset_id = d.id 
            WHERE d.is_active = 1`);
        
        const opts = {};
        const parser = new Parser(opts);
        const csv = parser.parse(result.rows);
        
        res.header('Content-Type', 'text/csv');
        res.attachment('reveal-stats.csv');
        res.send(csv);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = app;
