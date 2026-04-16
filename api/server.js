const express = require('express');
const { PrismaClient } = require('@prisma/client');
const cors = require('cors');
const multer = require('multer');
const csv = require('csv-parser');
const { Parser } = require('@json2csv/plainjs');
const fs = require('fs');
const rateLimit = require('express-rate-limit');
const path = require('path');

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

// ============================================
// HELPER FUNCTIONS
// ============================================

// Admin Auth Middleware
function requireAdmin(req, res, next) {
    const adminId = req.body.admin_id || req.body.adminId;
    const adminDate = req.body.admin_date || req.body.adminDate;
    
    if (adminId !== '090006' || adminDate !== '1976/02/14') {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

// CSV Header Normalization
const HEADER_MAP = {
    'id': 'nim', 'nim': 'nim',
    'nama': 'name', 'name': 'name',
    'tanggal_lahir': 'birth_date', 'birth_date': 'birth_date',
    'tanggal lahir': 'birth_date', 'tanggal_lahir': 'birth_date',
    'posisi': 'position', 'position': 'position',
    'divisi': 'division', 'division': 'division',
    'pesan': 'note', 'note': 'note', 'message': 'note'
};

function normalizeHeader(header) {
    const normalized = header.toLowerCase().trim().replace(/[_\s]+/g, '_');
    return HEADER_MAP[normalized] || normalized;
}

// ============================================
// ADMIN ENDPOINTS
// ============================================

// Admin Login
app.post('/api/admin/login', (req, res) => {
    const { adminId, adminDate } = req.body;
    if (adminId === '090006' && adminDate === '1976/02/14') {
        res.json({ success: true });
    } else {
        res.status(401).json({ success: false, message: "Kredensial salah" });
    }
});

// Get Datasets
app.post('/api/admin/datasets', requireAdmin, async (req, res) => {
    try {
        const datasets = await prisma.dataset.findMany({
            include: { _count: { select: { records: true } } },
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
        console.error('Error loading datasets:', err);
        res.status(500).json({ error: err.message });
    }
});

// Activate Dataset
app.post('/api/admin/activate', requireAdmin, async (req, res) => {
    const { dataset_id } = req.body;
    
    try {
        await prisma.$transaction(async (tx) => {
            await tx.dataset.updateMany({ data: { is_active: 0 } });
            await tx.dataset.update({
                where: { id: parseInt(dataset_id) },
                data: { is_active: 1 }
            });
        });

        res.json({ success: true, message: 'Dataset berhasil diaktifkan' });
    } catch (err) {
        console.error('Error activating:', err);
        res.status(500).json({ error: err.message });
    }
});

// Delete Dataset
app.post('/api/admin/delete', requireAdmin, async (req, res) => {
    const { dataset_id } = req.body;
    
    try {
        await prisma.dataset.delete({ where: { id: parseInt(dataset_id) } });
        res.json({ success: true, message: 'Dataset berhasil dihapus' });
    } catch (err) {
        console.error('Error deleting:', err);
        res.status(500).json({ error: err.message });
    }
});

// Get Logs
app.post('/api/admin/logs', requireAdmin, async (req, res) => {
    try {
        const datasets = await prisma.dataset.findMany({
            orderBy: { created_at: 'desc' },
            take: 20
        });

        const logs = datasets.map(ds => ({
            id: ds.id,
            action: ds.is_active ? 'DATASET_ACTIVATED' : 'DATASET_CREATED',
            details: `Dataset "${ds.name}" ${ds.is_active ? 'diaktifkan' : 'dibuat'}`,
            timestamp: ds.created_at
        }));

        res.json(logs);
    } catch (err) {
        console.error('Error loading logs:', err);
        res.status(500).json({ error: err.message });
    }
});

// Download Template
app.get('/api/admin/template', (req, res) => {
    const template = 'nim,name,birth_date,position,division,note\n090001,Budi Santoso,1990/05/15,Staff IT,IT,Selamat datang!\n090002,Ani Wijaya,1992/08/22,Manager HRD,HRD,Terima kasih!';
    
    res.header('Content-Type', 'text/csv');
    res.attachment('template_reveal_card.csv');
    res.send(template);
});

// Import CSV
app.post('/api/admin/import', upload.single('csv'), async (req, res) => {
    // PERBAIKAN: Ambil field Name dan Description dengan benar
    const datasetName = req.body.Name || req.body.name || 'Untitled Dataset';
    const datasetDesc = req.body.Description || req.body.description || '';
    
    const results = [];
    const errors = [];

    if (!req.file) {
        return res.status(400).json({ error: 'Tidak ada file yang diupload' });
    }

    fs.createReadStream(req.file.path)
        .pipe(csv({
            mapHeaders: ({ header }) => normalizeHeader(header)
        }))
        .on('data', (data) => {
            // Validasi minimal
            if (!data.nim && !data.name) {
                errors.push(`Baris ${results.length + 1}: NIM/ID dan Nama wajib diisi`);
                return;
            }
            
            results.push({
                nim: String(data.nim || data.id || '').trim(),
                name: String(data.name || data.nama || '').trim(),
                birth_date: data.birth_date || data.tanggal_lahir || null,
                position: String(data.position || data.posisi || '').trim(),
                division: String(data.division || data.divisi || '').trim(),
                note: String(data.note || data.pesan || data.message || '').trim()
            });
        })
        .on('end', async () => {
            try {
                if (errors.length > 0) {
                    return res.status(400).json({ error: 'Validasi gagal', details: errors });
                }
                
                if (results.length === 0) {
                    return res.status(400).json({ error: 'CSV kosong atau format tidak valid' });
                }

                await prisma.$transaction(async (tx) => {
                    await tx.dataset.updateMany({ data: { is_active: 0 } });
                    
                    const newDataset = await tx.dataset.create({
                        data: {
                            name: datasetName,
                            description: datasetDesc,
                            is_active: 1,
                            records: { create: results }
                        }
                    });

                    fs.unlinkSync(req.file.path);
                    
                    res.json({ 
                        success: true, 
                        message: `${results.length} data berhasil diimport`,
                        dataset: { id: newDataset.id, name: newDataset.name }
                    });
                } catch (err) {
                    console.error('Import error:', err);
                    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
                    res.status(500).json({ error: err.message });
                }
            }
        })
        .on('error', (err) => {
            console.error('CSV parsing error:', err);
            res.status(400).json({ error: 'Error parsing CSV: ' + err.message });
        });
});

// ============================================
// CLIENT ENDPOINTS
// ============================================

app.get('/api/client/stats', async (req, res) => {
    try {
        const activeDataset = await prisma.dataset.findFirst({
            where: { is_active: 1 },
            include: { _count: { select: { records: true } } }
        });

        if (!activeDataset) return res.json({ total: 0, revealed: 0 });

        const revealedCount = await prisma.Record.count({
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

app.post('/api/client/reveal', async (req, res) => {
    const { nim, birth_date } = req.body;
    try {
        const record = await prisma.Record.findFirst({
            where: {
                nim: nim,
                birth_date: birth_date,
                dataset: { is_active: 1 }
            }
        });

        if (!record) {
            return res.status(404).json({ success: false, message: "Data tidak ditemukan" });
        }

        if (record.is_revealed === 0) {
            await prisma.Record.update({
                where: { id: record.id },
                data: { is_revealed: 1, revealed_at: new Date() }
            });
        }

        res.json({ success: true, data: record });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/export', async (req, res) => {
    try {
        const records = await prisma.Record.findMany({
            where: { dataset: { is_active: 1 } },
            select: { nim: true, name: true, is_revealed: true, revealed_at: true }
        });
        
        const parser = new Parser();
        const csvData = parser.parse(records);
        res.header('Content-Type', 'text/csv').attachment('Stats.csv').send(csvData);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 404 Handler
app.use((req, res) => {
    res.status(404).json({ 
        error: 'Endpoint not found', 
        path: req.path, 
        method: req.method,
        available: [
            'POST /api/admin/login',
            'POST /api/admin/datasets',
            'POST /api/admin/activate', 
            'POST /api/admin/delete',
            'POST /api/admin/logs',
            'POST /api/admin/import',
            'GET /api/admin/template',
            'GET /api/admin/export',
            'GET /api/client/stats',
            'POST /api/client/reveal'
        ]
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

module.exports = app;
