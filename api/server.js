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

// ============================================
// HELPER FUNCTIONS
// ============================================
require('dotenv').config();

function requireAdmin(req, res, next) {
    const adminId = req.body.admin_id || req.body.adminId;
    const adminDate = req.body.admin_date || req.body.adminDate;
    
    if (adminId !== '090006' || adminDate !== '1976/02/14') {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

// CSV Header Normalization - PASTIKAN SEMUA LOWERCASE
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

app.post('/api/admin/login', (req, res) => {
    const { adminId, adminDate } = req.body;
    if (adminId === '090006' && adminDate === '1976/02/14') {
        res.json({ success: true });
    } else {
        res.status(401).json({ success: false, message: "Kredensial salah" });
    }
});

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

app.get('/api/admin/template', (req, res) => {
    const template = 'nim,name,birth_date,position,division,note\n090001,Budi Santoso,1990/05/15,Staff IT,IT,Selamat datang!\n090002,Ani Wijaya,1992/08/22,Manager HRD,HRD,Terima kasih!';
    
    res.header('Content-Type', 'text/csv');
    res.attachment('template_reveal_card.csv');
    res.send(template);
});

// ============================================
// IMPORT CSV - PERBAIKAN UTAMA
// ============================================

app.post('/api/admin/import', upload.single('csvFile'), async (req, res) => {
    // Ambil field dari frontend (case insensitive)
    const datasetName = req.body.Name || req.body.name || 'Untitled Dataset';
    const datasetDesc = req.body.Description || req.body.description || '';
    
    console.log('Import request:', { 
        name: datasetName, 
        description: datasetDesc,
        file: req.file?.originalname 
    });

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
            console.log('CSV Row:', JSON.stringify(data));
            
            // Validasi minimal
            if (!data.nim || !data.name) {
                errors.push(`Baris ${results.length + 1}: NIM dan Nama wajib diisi`);
                return;
            }
            
            // PASTIKAN SEMUA FIELD LOWERCASE
            results.push({
                nim: String(data.nim).trim(),
                name: String(data.name).trim(),
                birth_date: data.birth_date || null,
                position: String(data.position || '').trim(),
                division: String(data.division || '').trim(),
                note: String(data.note || '').trim()
            });
        })
        .on('end', async () => {
            console.log('Total rows:', results.length);
            console.log('Errors:', errors);
            
            try {
                if (errors.length > 0) {
                    fs.unlinkSync(req.file.path);
                    return res.status(400).json({ error: 'Validasi gagal', details: errors });
                }
                
                if (results.length === 0) {
                    fs.unlinkSync(req.file.path);
                    return res.status(400).json({ error: 'CSV kosong atau format tidak valid' });
                }

                // Debug: log hasil mapping
                console.log('First record:', JSON.stringify(results[0]));

                await prisma.$transaction(async (tx) => {
                    // Deactivate all
                    await tx.dataset.updateMany({ data: { is_active: 0 } });
                    
                    // Create new dataset with records
                    // PASTIKAN FIELD NAME SESUAI SCHEMA PRISMA (lowercase)
                    const newDataset = await tx.dataset.create({
                        data: {
                            name: datasetName,
                            description: datasetDesc,
                            is_active: 1,
                            records: { 
                                create: results.map(r => ({
                                    nim: r.nim,
                                    name: r.name,
                                    birth_date: r.birth_date,
                                    position: r.position,    // lowercase
                                    division: r.division,    // lowercase
                                    note: r.note             // lowercase
                                })) 
                            }
                        }
                    });

                    console.log('Created dataset:', newDataset.id);
                });

                // Cleanup
                fs.unlinkSync(req.file.path);
                
                res.json({ 
                    success: true, 
                    message: `${results.length} data berhasil diimport`
                });
                
            } catch (err) {
                console.error('Transaction error:', err);
                console.error('Error stack:', err.stack);
                
                if (fs.existsSync(req.file.path)) {
                    fs.unlinkSync(req.file.path);
                }
                
                res.status(500).json({ 
                    error: 'Database error', 
                    message: err.message,
                    details: err.meta || {}
                });
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

        if (!record) {
            return res.status(404).json({ success: false, message: "Data tidak ditemukan" });
        }

        if (record.is_revealed === 0) {
            await prisma.record.update({
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

// 404 Handler
app.use((req, res) => {
    res.status(404).json({ 
        error: 'Endpoint not found', 
        path: req.path, 
        method: req.method
    });
});

module.exports = app;
