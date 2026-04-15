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

// ============================================
// DATASET MANAGEMENT ENDPOINTS
// ============================================

// Get All Datasets
app.post('/api/admin/datasets', async (req, res) => {
    // Verifikasi admin credentials
    const { admin_id, admin_date } = req.body;
    if (admin_id !== '090006' || admin_date !== '1976/02/14') {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const datasets = await prisma.dataset.findMany({
            include: {
                _count: { select: { records: true } }
            },
            orderBy: { created_at: 'desc' }
        });

        const formatted = datasets.map(ds => ({
            id: ds.id,
            name: ds.name,
            description: ds.description || '',
            created_at: ds.created_at,
            is_active: ds.is_active === 1,
            actual_count: ds._count.records
        }));

        res.json(formatted);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Activate Dataset
app.post('/api/admin/activate', async (req, res) => {
    const { admin_id, admin_date, dataset_id } = req.body;
    
    if (admin_id !== '090006' || admin_date !== '1976/02/14') {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        await prisma.$transaction(async (tx) => {
            // Deactivate all
            await tx.dataset.updateMany({
                data: { is_active: 0 }
            });
            
            // Activate selected
            await tx.dataset.update({
                where: { id: parseInt(dataset_id) },
                data: { is_active: 1 }
            });
        });

        res.json({ success: true, message: 'Dataset activated' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete Dataset
app.post('/api/admin/delete', async (req, res) => {
    const { admin_id, admin_date, dataset_id } = req.body;
    
    if (admin_id !== '090006' || admin_date !== '1976/02/14') {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        await prisma.dataset.delete({
            where: { id: parseInt(dataset_id) }
        });

        res.json({ success: true, message: 'Dataset deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get Activity Logs
app.post('/api/admin/logs', async (req, res) => {
    const { admin_id, admin_date } = req.body;
    
    if (admin_id !== '090006' || admin_date !== '1976/02/14') {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        // Jika ada tabel logs, gunakan itu. Jika tidak, return array kosong
        // Atau Anda bisa buat log dari aktivitas dataset
        const datasets = await prisma.dataset.findMany({
            orderBy: { created_at: 'desc' },
            take: 10,
            select: {
                id: true,
                name: true,
                created_at: true,
                is_active: true
            }
        });

        const logs = datasets.map(ds => ({
            id: ds.id,
            action: ds.is_active ? 'DATASET_ACTIVATED' : 'DATASET_CREATED',
            details: `Dataset "${ds.name}" ${ds.is_active ? 'diaktifkan' : 'dibuat'}`,
            timestamp: ds.created_at
        }));

        res.json(logs);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Download Template CSV
app.get('/api/admin/template', (req, res) => {
    const template = 'nim,name,birth_date,position,division,note\n090001,Budi Santoso,1990/05/15,Staff IT,IT,Selamat datang!\n090002,Ani Wijaya,1992/08/22,Manager HRD,HRD,Terima kasih!';
    
    res.header('Content-Type', 'text/csv');
    res.attachment('template_reveal_card.csv');
    res.send(template);
});

module.exports = app;
