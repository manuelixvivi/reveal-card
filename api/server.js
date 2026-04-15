const express = require('express');
const { PrismaClient } = require('@prisma/client');
const cors = require('cors');
const multer = require('multer');
const csv = require('csv-parser');
const { Parser } = require('@json2csv/plainjs');
const fs = require('fs');
const rateLimit = require('express-rate-limit');

const app = express();
const prisma = new PrismaClient();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100
});
app.use('/api/', limiter);

const upload = multer({ dest: '/tmp/' });

// Admin Login
app.post('/api/admin/login', (req, res) => {
    const { adminId, adminDate } = req.body;
    if (adminId === '090006' && adminDate === '1976/02/14') {
        res.json({ success: true });
    } else {
        res.status(401).json({ success: false, message: "Kredensial salah" });
    }
});

// Import CSV menggunakan Prisma
app.post('/api/admin/import', upload.single('csvFile'), async (req, res) => {
    const datasetName = req.body.datasetName || 'Untitled Dataset';
    const results = [];

    if (!req.file) return res.status(400).json({ error: 'Tidak ada file' });

    fs.createReadStream(req.file.path)
        .pipe(csv())
        .on('data', (data) => results.push(data))
        .on('end', async () => {
            try {
                // Transaksi: Matikan dataset lama & buat yang baru
                await prisma.$transaction(async (tx) => {
                    await tx.dataset.updateMany({
                        data: { is_active: 0 }
                    });

                    const newDataset = await tx.dataset.create({
                        data: {
                            name: datasetName,
                            is_active: 1,
                            records: {
                                create: results.map(row => ({
                                    nim: row.nim,
                                    name: row.name,
                                    birth_date: row.birth_date,
                                    position: row.position,
                                    division: row.division,
                                    note: row.note
                                }))
                            }
                        }
                    });
                });

                res.json({ success: true, message: `${results.length} data diimport` });
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        });
});

// Get Stats
app.get('/api/client/stats', async (req, res) => {
    try {
        const activeDataset = await prisma.dataset.findFirst({
            where: { is_active: 1 },
            include: {
                _count: {
                    select: { records: true }
                }
            }
        });

        if (!activeDataset) return res.json({ total: 0, revealed: 0 });

        const revealedCount = await prisma.record.count({
            where: { dataset_id: activeDataset.id, is_revealed: 1 }
        });

        res.json({
            total: activeDataset._count.records,
            revealed: revealedCount
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Reveal Card (Login Client)
app.post('/api/client/reveal', async (req, res) => {
    const { nim, birth_date } = req.body;
    try {
        const record = await prisma.record.findFirst({
            where: {
                nim: nim,
                birth_date: birth_date,
                dataset: { is_active: 1 }
            }
        });

        if (record) {
            if (record.is_revealed === 0) {
                await prisma.record.update({
                    where: { id: record.id },
                    data: { 
                        is_revealed: 1, 
                        revealed_at: new Date() 
                    }
                });
            }
            res.json({ success: true, data: record });
        } else {
            res.status(404).json({ success: false, message: "Data tidak ditemukan" });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Export Data
app.get('/api/admin/export', async (req, res) => {
    try {
        const records = await prisma.record.findMany({
            where: { dataset: { is_active: 1 } },
            select: { nim: true, name: true, is_revealed: true, revealed_at: true }
        });
        
        const parser = new Parser();
        const csvData = parser.parse(records);
        res.header('Content-Type', 'text/csv').attachment('stats.csv').send(csvData);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = app;
