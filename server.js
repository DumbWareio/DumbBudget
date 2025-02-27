const dotenv = require('dotenv').config();
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const crypto = require('crypto');
const path = require('path');
const cookieParser = require('cookie-parser');
const fs = require('fs').promises;

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Get the project name from package.json to use for the PIN environment variable
const projectName = require('./package.json').name.toUpperCase().replace(/-/g, '_');
const PIN = process.env[`${projectName}_PIN`];

// Ensure data directory exists
const DATA_DIR = path.join(__dirname, 'data');
const TRANSACTIONS_FILE = path.join(DATA_DIR, 'transactions.json');

// Debug logging setup
const DEBUG = process.env.DEBUG === 'TRUE';
function debugLog(...args) {
    if (DEBUG) {
        console.log('[DEBUG]', ...args);
    }
}

// Add logging to BASE_PATH extraction
const BASE_PATH = (() => {
    if (!process.env.BASE_URL) {
        debugLog('No BASE_URL set, using empty base path');
        return '';
    }
    try {
        const url = new URL(process.env.BASE_URL);
        const path = url.pathname.replace(/\/$/, ''); // Remove trailing slash
        debugLog('Extracted base path:', path);
        return path;
    } catch {
        // If BASE_URL is just a path (e.g. /budget)
        const path = process.env.BASE_URL.replace(/\/$/, '');
        debugLog('Using BASE_URL as path:', path);
        return path;
    }
})();

async function ensureDataDir() {
    try {
        await fs.access(DATA_DIR);
    } catch {
        await fs.mkdir(DATA_DIR);
    }
}

async function loadTransactions() {
    try {
        await fs.access(TRANSACTIONS_FILE);
        const data = await fs.readFile(TRANSACTIONS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        // If file doesn't exist or is invalid, return empty structure
        return {
            [new Date().toISOString().slice(0, 7)]: {
                income: [],
                expenses: []
            }
        };
    }
}

async function saveTransactions(transactions) {
    // Ensure data directory exists before saving
    await ensureDataDir();
    await fs.writeFile(TRANSACTIONS_FILE, JSON.stringify(transactions, null, 2));
}

// Initialize data directory
ensureDataDir().catch(console.error);

// Log whether PIN protection is enabled
if (!PIN || PIN.trim() === '') {
    console.log('PIN protection is disabled');
} else {
    console.log('PIN protection is enabled');
}

// Brute force protection
const loginAttempts = new Map();
const MAX_ATTEMPTS = 5;
const LOCKOUT_TIME = 15 * 60 * 1000; // 15 minutes in milliseconds

function resetAttempts(ip) {
    loginAttempts.delete(ip);
}

function isLockedOut(ip) {
    const attempts = loginAttempts.get(ip);
    if (!attempts) return false;
    
    if (attempts.count >= MAX_ATTEMPTS) {
        const timeElapsed = Date.now() - attempts.lastAttempt;
        if (timeElapsed < LOCKOUT_TIME) {
            return true;
        }
        resetAttempts(ip);
    }
    return false;
}

function recordAttempt(ip) {
    const attempts = loginAttempts.get(ip) || { count: 0, lastAttempt: 0 };
    attempts.count += 1;
    attempts.lastAttempt = Date.now();
    loginAttempts.set(ip, attempts);
}

// Security middleware - minimal configuration like DumbDrop
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: false,
    originAgentCluster: false,
    dnsPrefetchControl: false,
    frameguard: false,
    hsts: false,
    ieNoOpen: false,
    noSniff: false,
    permittedCrossDomainPolicies: false,
    referrerPolicy: false,
    xssFilter: false
}));

app.use(express.json());
app.use(cookieParser());

// Session configuration - simplified like DumbDrop
app.use(session({
    secret: crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: true,
    cookie: {
        secure: false,
        httpOnly: true,
        sameSite: 'lax'
    }
}));

// Constant-time PIN comparison to prevent timing attacks
function verifyPin(storedPin, providedPin) {
    if (!storedPin || !providedPin) return false;
    if (storedPin.length !== providedPin.length) return false;
    
    try {
        return crypto.timingSafeEqual(
            Buffer.from(storedPin),
            Buffer.from(providedPin)
        );
    } catch {
        return false;
    }
}

// Add logging to authentication middleware
const authMiddleware = (req, res, next) => {
    debugLog('Auth middleware for path:', req.path);
    // If no PIN is set, bypass authentication
    if (!PIN || PIN.trim() === '') {
        debugLog('PIN protection disabled, bypassing auth');
        return next();
    }

    // Check if user is authenticated via session
    if (!req.session.authenticated) {
        debugLog('User not authenticated, redirecting to login');
        return res.redirect(BASE_PATH + '/login');
    }
    debugLog('User authenticated, proceeding');
    next();
};

// Mount all routes under BASE_PATH
app.use(BASE_PATH, express.static('public', { index: false }));

// Routes
app.get(BASE_PATH + '/', authMiddleware, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get(BASE_PATH + '/login', (req, res) => {
    if (!PIN || PIN.trim() === '') {
        return res.redirect(BASE_PATH + '/');
    }
    if (req.session.authenticated) {
        return res.redirect(BASE_PATH + '/');
    }
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get(BASE_PATH + '/api/config', (req, res) => {
    let instanceName = process.env.INSTANCE_NAME;
    if (instanceName == undefined) {
        instanceName = 'DumbBudget';
    } else {
        instanceName = `DumbBudget - ${process.env.INSTANCE_NAME}`
    }
    res.json({ instanceName: instanceName });
});

app.get(BASE_PATH + '/pin-length', (req, res) => {
    // If no PIN is set, return 0 length
    if (!PIN || PIN.trim() === '') {
        return res.json({ length: 0 });
    }
    res.json({ length: PIN.length });
});

app.post(BASE_PATH + '/verify-pin', (req, res) => {
    // If no PIN is set, authentication is successful
    if (!PIN || PIN.trim() === '') {
        req.session.authenticated = true;
        return res.status(200).json({ success: true });
    }

    const ip = req.ip;
    
    // Check if IP is locked out
    if (isLockedOut(ip)) {
        const attempts = loginAttempts.get(ip);
        const timeLeft = Math.ceil((LOCKOUT_TIME - (Date.now() - attempts.lastAttempt)) / 1000 / 60);
        return res.status(429).json({ 
            error: `Too many attempts. Please try again in ${timeLeft} minutes.`
        });
    }

    const { pin } = req.body;
    
    if (!pin || typeof pin !== 'string') {
        return res.status(400).json({ error: 'Invalid PIN format' });
    }

    // Add artificial delay to further prevent timing attacks
    const delay = crypto.randomInt(50, 150);
    setTimeout(() => {
        if (verifyPin(PIN, pin)) {
            // Reset attempts on successful login
            resetAttempts(ip);
            
            // Set authentication in session
            req.session.authenticated = true;
            
            // Set secure cookie
            res.cookie(`${projectName}_PIN`, pin, {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: 'strict',
                maxAge: 24 * 60 * 60 * 1000 // 24 hours
            });
            
            res.status(200).json({ success: true });
        } else {
            // Record failed attempt
            recordAttempt(ip);
            
            const attempts = loginAttempts.get(ip);
            const attemptsLeft = MAX_ATTEMPTS - attempts.count;
            
            res.status(401).json({ 
                error: 'Invalid PIN',
                attemptsLeft: Math.max(0, attemptsLeft)
            });
        }
    }, delay);
});

// Cleanup old lockouts periodically
setInterval(() => {
    const now = Date.now();
    for (const [ip, attempts] of loginAttempts.entries()) {
        if (now - attempts.lastAttempt >= LOCKOUT_TIME) {
            loginAttempts.delete(ip);
        }
    }
}, 60000); // Clean up every minute

// Helper function to get transactions within date range
async function getTransactionsInRange(startDate, endDate) {
    const transactions = await loadTransactions();
    const allTransactions = [];
    
    // Collect all transactions within the date range
    Object.values(transactions).forEach(month => {
        // Safely handle income transactions
        if (month && Array.isArray(month.income)) {
            const incomeInRange = month.income.filter(t => 
                t.date >= startDate && t.date <= endDate
            ).map(t => ({ ...t, type: 'income' }));
            allTransactions.push(...incomeInRange);
        }
        
        // Safely handle expense transactions
        if (month && Array.isArray(month.expenses)) {
            const expensesInRange = month.expenses.filter(t => 
                t.date >= startDate && t.date <= endDate
            ).map(t => ({ ...t, type: 'expense' }));
            allTransactions.push(...expensesInRange);
        }
    });
    
    return allTransactions.sort((a, b) => new Date(b.date) - new Date(a.date));
}

// API Routes - all under BASE_PATH
app.post(BASE_PATH + '/api/transactions', authMiddleware, async (req, res) => {
    try {
        const { type, amount, description, category, date } = req.body;
        
        // Basic validation
        if (!type || !amount || !description || !date) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        if (type !== 'income' && type !== 'expense') {
            return res.status(400).json({ error: 'Invalid transaction type' });
        }
        if (type === 'expense' && !category) {
            return res.status(400).json({ error: 'Category required for expenses' });
        }

        const transactions = await loadTransactions() || {};
        const [year, month] = date.split('-');
        const key = `${year}-${month}`;

        // Initialize month structure if it doesn't exist
        if (!transactions[key]) {
            transactions[key] = {
                income: [],
                expenses: []
            };
        }

        // Ensure arrays exist
        if (!Array.isArray(transactions[key].income)) {
            transactions[key].income = [];
        }
        if (!Array.isArray(transactions[key].expenses)) {
            transactions[key].expenses = [];
        }

        // Add transaction
        const newTransaction = {
            id: crypto.randomUUID(),
            amount: parseFloat(amount),
            description,
            date
        };

        if (type === 'expense') {
            newTransaction.category = category;
            transactions[key].expenses.push(newTransaction);
        } else {
            transactions[key].income.push(newTransaction);
        }

        await saveTransactions(transactions);
        res.status(201).json(newTransaction);
    } catch (error) {
        console.error('Error adding transaction:', error);
        res.status(500).json({ error: 'Failed to add transaction' });
    }
});

app.get(BASE_PATH + '/api/transactions/:year/:month', authMiddleware, async (req, res) => {
    try {
        const { year, month } = req.params;
        const key = `${year}-${month.padStart(2, '0')}`;
        const transactions = await loadTransactions();
        
        const monthData = transactions[key] || { income: [], expenses: [] };
        
        // Combine and sort transactions by date
        const allTransactions = [
            ...monthData.income.map(t => ({ ...t, type: 'income' })),
            ...monthData.expenses.map(t => ({ ...t, type: 'expense' }))
        ].sort((a, b) => new Date(b.date) - new Date(a.date));

        res.json(allTransactions);
    } catch (error) {
        console.error('Error fetching transactions:', error);
        res.status(500).json({ error: 'Failed to fetch transactions' });
    }
});

app.get(BASE_PATH + '/api/totals/:year/:month', authMiddleware, async (req, res) => {
    try {
        const { year, month } = req.params;
        const key = `${year}-${month.padStart(2, '0')}`;
        const transactions = await loadTransactions();
        
        const monthData = transactions[key] || { income: [], expenses: [] };
        
        const totals = {
            income: monthData.income.reduce((sum, t) => sum + t.amount, 0),
            expenses: monthData.expenses.reduce((sum, t) => sum + t.amount, 0),
            balance: 0
        };
        
        totals.balance = totals.income - totals.expenses;
        
        res.json(totals);
    } catch (error) {
        console.error('Error calculating totals:', error);
        res.status(500).json({ error: 'Failed to calculate totals' });
    }
});

app.get(BASE_PATH + '/api/transactions/range', authMiddleware, async (req, res) => {
    try {
        const { start, end } = req.query;
        if (!start || !end) {
            return res.status(400).json({ error: 'Start and end dates are required' });
        }

        const transactions = await getTransactionsInRange(start, end);
        res.json(transactions);
    } catch (error) {
        console.error('Error fetching transactions:', error);
        res.status(500).json({ error: 'Failed to fetch transactions' });
    }
});

app.get(BASE_PATH + '/api/totals/range', authMiddleware, async (req, res) => {
    try {
        const { start, end } = req.query;
        if (!start || !end) {
            return res.status(400).json({ error: 'Start and end dates are required' });
        }

        const transactions = await getTransactionsInRange(start, end);
        
        const totals = {
            income: transactions
                .filter(t => t.type === 'income')
                .reduce((sum, t) => sum + t.amount, 0),
            expenses: transactions
                .filter(t => t.type === 'expense')
                .reduce((sum, t) => sum + t.amount, 0),
            balance: 0
        };
        
        totals.balance = totals.income - totals.expenses;
        
        res.json(totals);
    } catch (error) {
        console.error('Error calculating totals:', error);
        res.status(500).json({ error: 'Failed to calculate totals' });
    }
});

app.get(BASE_PATH + '/api/export/:year/:month', authMiddleware, async (req, res) => {
    try {
        const { year, month } = req.params;
        const key = `${year}-${month.padStart(2, '0')}`;
        const transactions = await loadTransactions();
        
        const monthData = transactions[key] || { income: [], expenses: [] };
        
        // Combine all transactions
        const allTransactions = [
            ...monthData.income.map(t => ({ ...t, type: 'income' })),
            ...monthData.expenses.map(t => ({ ...t, type: 'expense' }))
        ].sort((a, b) => new Date(b.date) - new Date(a.date));

        // Convert to CSV
        const csvRows = ['Date,Type,Category,Description,Amount'];
        allTransactions.forEach(t => {
            csvRows.push(`${t.date},${t.type},${t.category || ''},${t.description},${t.amount}`);
        });

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=transactions-${key}.csv`);
        res.send(csvRows.join('\n'));
    } catch (error) {
        console.error('Error exporting transactions:', error);
        res.status(500).json({ error: 'Failed to export transactions' });
    }
});

app.get(BASE_PATH + '/api/export/range', authMiddleware, async (req, res) => {
    try {
        const { start, end } = req.query;
        if (!start || !end) {
            return res.status(400).json({ error: 'Start and end dates are required' });
        }

        const transactions = await getTransactionsInRange(start, end);

        // Convert to CSV with specified format
        const csvRows = ['Category,Date,Description,Value'];
        transactions.forEach(t => {
            const category = t.type === 'income' ? 'Income' : t.category;
            const value = t.type === 'income' ? t.amount : -t.amount;
            // Escape description to handle commas and quotes
            const escapedDescription = t.description.replace(/"/g, '""');
            const formattedDescription = escapedDescription.includes(',') ? `"${escapedDescription}"` : escapedDescription;
            
            csvRows.push(`${category},${t.date},${formattedDescription},${value}`);
        });

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=transactions-${start}-to-${end}.csv`);
        res.send(csvRows.join('\n'));
    } catch (error) {
        console.error('Error exporting transactions:', error);
        res.status(500).json({ error: 'Failed to export transactions' });
    }
});

app.put(BASE_PATH + '/api/transactions/:id', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const { type, amount, description, category, date } = req.body;
        
        // Basic validation
        if (!type || !amount || !description || !date) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        if (type !== 'income' && type !== 'expense') {
            return res.status(400).json({ error: 'Invalid transaction type' });
        }
        if (type === 'expense' && !category) {
            return res.status(400).json({ error: 'Category required for expenses' });
        }

        const transactions = await loadTransactions();
        let found = false;
        
        // Find and update the transaction
        for (const key of Object.keys(transactions)) {
            const monthData = transactions[key];
            
            // Check in income array
            const incomeIndex = monthData.income.findIndex(t => t.id === id);
            if (incomeIndex !== -1) {
                // If type changed, move to expenses
                if (type === 'expense') {
                    const transaction = monthData.income.splice(incomeIndex, 1)[0];
                    transaction.category = category;
                    monthData.expenses.push({
                        ...transaction,
                        amount: parseFloat(amount),
                        description,
                        date
                    });
                } else {
                    monthData.income[incomeIndex] = {
                        ...monthData.income[incomeIndex],
                        amount: parseFloat(amount),
                        description,
                        date
                    };
                }
                found = true;
                break;
            }
            
            // Check in expenses array
            const expenseIndex = monthData.expenses.findIndex(t => t.id === id);
            if (expenseIndex !== -1) {
                // If type changed, move to income
                if (type === 'income') {
                    const transaction = monthData.expenses.splice(expenseIndex, 1)[0];
                    delete transaction.category;
                    monthData.income.push({
                        ...transaction,
                        amount: parseFloat(amount),
                        description,
                        date
                    });
                } else {
                    monthData.expenses[expenseIndex] = {
                        ...monthData.expenses[expenseIndex],
                        amount: parseFloat(amount),
                        description,
                        category,
                        date
                    };
                }
                found = true;
                break;
            }
        }

        if (!found) {
            return res.status(404).json({ error: 'Transaction not found' });
        }

        await saveTransactions(transactions);
        res.json({ success: true });
    } catch (error) {
        console.error('Error updating transaction:', error);
        res.status(500).json({ error: 'Failed to update transaction' });
    }
});

app.delete(BASE_PATH + '/api/transactions/:id', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const transactions = await loadTransactions();
        let found = false;
        
        // Find and delete the transaction
        for (const key of Object.keys(transactions)) {
            const monthData = transactions[key];
            
            // Check in income array
            const incomeIndex = monthData.income.findIndex(t => t.id === id);
            if (incomeIndex !== -1) {
                monthData.income.splice(incomeIndex, 1);
                found = true;
                break;
            }
            
            // Check in expenses array
            const expenseIndex = monthData.expenses.findIndex(t => t.id === id);
            if (expenseIndex !== -1) {
                monthData.expenses.splice(expenseIndex, 1);
                found = true;
                break;
            }
        }

        if (!found) {
            return res.status(404).json({ error: 'Transaction not found' });
        }

        await saveTransactions(transactions);
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting transaction:', error);
        res.status(500).json({ error: 'Failed to delete transaction' });
    }
});

// Supported currencies list - must match client-side list
const SUPPORTED_CURRENCIES = [
    'USD', 'EUR', 'GBP', 'JPY', 'AUD', 
    'CAD', 'CHF', 'CNY', 'HKD', 'NZD',
    'MXN', 'RUB', 'SGD', 'KRW', 'INR',
    'BRL', 'ZAR', 'TRY', 'PLN', 'SEK',
    'NOK', 'DKK', 'IDR', 'PHP'
];

// Get current currency setting
app.get(BASE_PATH + '/api/settings/currency', authMiddleware, (req, res) => {
    const currency = process.env.CURRENCY || 'USD';
    if (!SUPPORTED_CURRENCIES.includes(currency)) {
        return res.status(200).json({ currency: 'USD' });
    }
    res.status(200).json({ currency });
});

// Get list of supported currencies
app.get(BASE_PATH + '/api/settings/supported-currencies', authMiddleware, (req, res) => {
    res.status(200).json({ currencies: SUPPORTED_CURRENCIES });
});

// Add logging to config endpoint
app.get(BASE_PATH + '/config.js', (req, res) => {
    debugLog('Serving config.js with BASE_PATH:', BASE_PATH);
    res.type('application/javascript').send(`
        window.appConfig = {
            basePath: '${BASE_PATH}',
            debug: ${DEBUG}
        };
    `);
});

// Add logging to server startup
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    debugLog('Debug mode enabled');
    debugLog('Base path:', BASE_PATH);
}); 
