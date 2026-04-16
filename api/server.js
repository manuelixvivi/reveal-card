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

// ============================================
// MIDDLEWARE SETUP
// ============================================

// CORS dengan konfigurasi lebih detail
app.use(cors({
    origin: ['http://localhost:3000', 'http://localhost:3001', 'https://reveal-card.vercel.app'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// Hapus Permissions-Policy yang problematic
app.use((req, res, next) => {
    res.removeHeader('Permissions-Policy');
    next();
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: 'Terlalu banyak request, coba lagi nanti'
});
app.use('/api/', limiter);

// Multer dengan konfigurasi yang lebih aman
const upload = multer({ 
    dest: '/tmp/',
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
            cb(null, true);
        } else {
            cb(new Error('Hanya file CSV yang diperbolehkan'));
        }
    }
});

// ============================================
// HELPER FUNCTIONS
// ============================================

// Admin Auth Middleware
function requireAdmin(req, res, next) {
    const adminId = req.body.admin_id || req.body.adminId;
    const adminDate = req.body.admin_date || req.body.adminDate;
    
    if (adminId !== '090006' || adminDate !== '1976/02/14') {
        return res.status(401).json({ error: 'Unauthorized', message: 'Kredensial admin tidak valid' });
    }
    next();
}

// CSV Header Normalization
const HEADER_MAP = {
    'id': 'nim', 'nim': 'nim',
    'nama': 'name', 'name': 'name',
    'tanggal_lahir': 'birth_date', 'birth_date': 'birth_date',
    'tanggal lahir': 'birth_date',
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
    try {
        const { adminId, adminDate } = req.body;
        if (adminId === '090006' && adminDate === '1976/02/14') {
            res.json({ success: true, message: 'Login berhasil' });
        } else {
            res.status(401).json({ success: false, message: "Kredensial salah" });
        }
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Internal server error', message: err.message });
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
        res.status(500).json({ error: 'Database error', message: err.message });
    }
});

// Activate Dataset
app.post('/api/admin/activate', requireAdmin, async (req, res) => {
    const { dataset_id } = req.body;
    
    try {
        if (!dataset_id) {
            return res.status(400).json({ error: 'dataset_id diperlukan' });
        }

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
        res.status(500).json({ error: 'Database error', message: err.message });
    }
});

// Delete Dataset
app.post('/api/admin/delete', requireAdmin, async (req, res) => {
    const { dataset_id } = req.body;
    
    try {
        if (!dataset_id) {
            return res.status(400).json({ error: 'dataset_id diperlukan' });
        }

        await prisma.dataset.delete({ where: { id: parseInt(dataset_id) } });
        res.json({ success: true, message: 'Dataset berhasil dihapus' });
    } catch (err) {
        console.error('Error deleting:', err);
        res.status(500).json({ error: 'Database error', message: err.message });
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
        res.status(500).json({ error: 'Database error', message: err.message });
    }
});

// Download Template
app.get('/api/admin/template', (req, res) => {
    try {
        const template = 'nim,name,birth_date,position,division,note\n090001,Budi Santoso,1990/05/15,Staff IT,IT,Selamat datang!\n090002,Ani Wijaya,1992/08/22,Manager HRD,HRD,Terima kasih!';
        
        res.header('Content-Type', 'text/csv');
        res.attachment('template_reveal_card.csv');
        res.send(template);
    } catch (err) {
        console.error('Template error:', err);
        res.status(500).json({ error: 'Error generating template', message: err.message });
    }
});

// Import CSV - PERBAIKAN UTAMA
app.post('/api/admin/import', upload.single('csv'), async (req, res) => {
    const datasetName = req.body.Name || req.body.name || 'Untitled Dataset';
    const datasetDesc = req.body.Description || req.body.description || '';
    
    const results = [];
    const errors = [];

    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Tidak ada file yang diupload' });
        }

        // Cek apakah file ada
        if (!fs.existsSync(req.file.path)) {
            return res.status(400).json({ error: 'File upload gagal' });
        }

        const stream = fs.createReadStream(req.file.path);
        
        stream.on('error', (err) => {
            console.error('Stream error:', err);
            if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
            res.status(400).json({ error: 'Error reading file', message: err.message });
        });

        stream
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
                    // Validasi error
                    if (errors.length > 0) {
                        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
                        return res.status(400).json({ error: 'Validasi gagal', details: errors });
                    }
                    
                    if (results.length === 0) {
                        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
                        return res.status(400).json({ error: 'CSV kosong atau format tidak valid' });
                    }

                    // Simpan ke database
                    const newDataset = await prisma.dataset.create({
                        data: {
                            name: datasetName,
                            description: datasetDesc,
                            is_active: 1,
                            records: { create: results }
                        }
                    });

                    // Deaktifkan dataset lama setelah membuat yang baru
                    await prisma.dataset.updateMany({
                        where: { id: { not: newDataset.id } },
                        data: { is_active: 0 }
                    });

                    // Hapus file
                    if (fs.existsSync(req.file.path)) {
                        fs.unlinkSync(req.file.path);
                    }
                    
                    res.json({ 
                        success: true, 
                        message: `${results.length} data berhasil diimport`,
                        dataset: { id: newDataset.id, name: newDataset.name }
                    });
                } catch (err) {
                    console.error('Import database error:', err);
                    if (fs.existsSync(req.file.path)) {
                        fs.unlinkSync(req.file.path);
                    }
                    res.status(500).json({ error: 'Database error', message: err.message });
                }
            })
            .on('error', (err) => {
                console.error('CSV parsing error:', err);
                if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
                res.status(400).json({ error: 'Error parsing CSV', message: err.message });
            });

    } catch (err) {
        console.error('Import error:', err);
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
        res.status(500).json({ error: 'Server error', message: err.message });
    }
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

        if (!activeDataset) {
            return res.json({ total: 0, revealed: 0 });
        }

        const revealedCount = await prisma.Record.count({
            where: { dataset_id: activeDataset.id, is_revealed: 1 }
        });

        res.json({
            total: activeDataset._count.records,
            revealed: revealedCount
        });
    } catch (err) {
        console.error('Stats error:', err);
        res.status(500).json({ error: 'Database error', message: err.message });
    }
});

app.post('/api/client/reveal', async (req, res) => {
    const { nim, birth_date } = req.body;
    try {
        if (!nim || !birth_date) {
            return res.status(400).json({ error: 'NIM dan birth_date diperlukan' });
        }

        const record = await prisma.Record.findFirst({
            where: {
                nim: String(nim),
                birth_date: String(birth_date),
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
        console.error('Reveal error:', err);
        res.status(500).json({ error: 'Database error', message: err.message });
    }
});

app.get('/api/admin/export', async (req, res) => {
    try {
        const records = await prisma.Record.findMany({
            where: { dataset: { is_active: 1 } },
            select: { nim: true, name: true, is_revealed: true, revealed_at: true }
        });
        
        if (records.length === 0) {
            return res.status(400).json({ error: 'Tidak ada data untuk diexport' });
        }

        const parser = new Parser();
        const csvData = parser.parse(records);
        res.header('Content-Type', 'text/csv').attachment('Stats.csv').send(csvData);
    } catch (err) {
        console.error('Export error:', err);
        res.status(500).json({ error: 'Database error', message: err.message });
    }
});

// ============================================
// ERROR HANDLING
// ============================================

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

// Error handler global
app.use((err, req, res, next) => {
    console.error('Global error handler:', err);
    
    if (err instanceof SyntaxError && 'body' in err) {
        return res.status(400).json({ error: 'Invalid JSON', message: err.message });
    }
    
    if (err.message.includes('Hanya file CSV')) {
        return res.status(400).json({ error: 'Invalid file type', message: err.message });
    }
    
    res.status(500).json({ 
        error: 'Internal server error', 
        message: err.message || 'Unknown error'
    });
});

// ============================================
// SERVER START
// ============================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

module.exports = app;
