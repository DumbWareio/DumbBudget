const dotenv = require('dotenv').config();
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const crypto = require('crypto');
const path = require('path');
const cookieParser = require('cookie-parser');
const fs = require('fs').promises;
const cors = require('cors');
const { getCorsOptions, originValidationMiddleware } = require('./scripts/cors');
const { generatePWAManifest } = require('./scripts/pwa-manifest-generator');

const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'production';
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const SITE_TITLE = process.env.SITE_TITLE || 'DumbBudget';
const INSTANCE_NAME = process.env.INSTANCE_NAME || '';
const SITE_INSTANCE_TITLE = INSTANCE_NAME ? `${SITE_TITLE} - ${INSTANCE_NAME}` : SITE_TITLE;
const PUBLIC_DIR = path.join(__dirname, 'public');
const ASSETS_DIR = path.join(PUBLIC_DIR, 'assets');

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

// Input sanitization function to prevent XSS attacks
function sanitizeInput(input) {
    if (typeof input !== 'string') return input;
    return input
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;')
        .replace(/\//g, '&#x2F;');
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

generatePWAManifest(SITE_INSTANCE_TITLE);

// Middleware
// Trust proxy - required for secure cookies behind a reverse proxy
app.set('trust proxy', 1);

// Cors Setup
const corsOptions = getCorsOptions(BASE_URL);
app.use(cors(corsOptions));

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
app.get(BASE_PATH + '/', [originValidationMiddleware, authMiddleware], (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve the pwa/asset manifest
app.get('/asset-manifest.json', (req, res) => {
    // generated in pwa-manifest-generator and fetched from service-worker.js
    res.sendFile(path.join(ASSETS_DIR, 'asset-manifest.json'));
});
app.get('/manifest.json', (req, res) => {
    res.sendFile(path.join(ASSETS_DIR, 'manifest.json'));
});

app.get('/managers/toast', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'managers', 'toast.js'));
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
    const instanceName = SITE_INSTANCE_TITLE;
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
                secure: req.secure || (BASE_URL.startsWith('https') && NODE_ENV === 'production'),
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
    const recurringTransactions = [];
    
    // Collect all transactions within the date range
    Object.values(transactions).forEach(month => {
        // Safely handle income transactions
        if (month && Array.isArray(month.income)) {
            month.income.forEach(t => {
                if (t.recurring?.pattern) {
                    // For recurring transactions, only add to recurring array
                    recurringTransactions.push({ ...t, type: 'income' });
                } else if (t.date >= startDate && t.date <= endDate) {
                    // For non-recurring, add to all transactions if in range
                    allTransactions.push({ ...t, type: 'income' });
                }
            });
        }
        
        // Safely handle expense transactions
        if (month && Array.isArray(month.expenses)) {
            month.expenses.forEach(t => {
                if (t.recurring?.pattern) {
                    // For recurring transactions, only add to recurring array
                    recurringTransactions.push({ ...t, type: 'expense' });
                } else if (t.date >= startDate && t.date <= endDate) {
                    // For non-recurring, add to all transactions if in range
                    allTransactions.push({ ...t, type: 'expense' });
                }
            });
        }
    });
    
    // Generate recurring instances
    const recurringInstances = [];
    for (const transaction of recurringTransactions) {
        recurringInstances.push(...generateRecurringInstances(transaction, startDate, endDate));
    }
    
    // Combine all transactions and instances
    return [...allTransactions, ...recurringInstances]
        .sort((a, b) => new Date(b.date) - new Date(a.date));
}

// API Routes - all under BASE_PATH
app.post(BASE_PATH + '/api/transactions', authMiddleware, async (req, res) => {
    try {
        const { type, amount, description, category, date, recurring, notes } = req.body;
        
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

        // Validate recurring pattern if present
        if (recurring?.pattern) {
            const isValidRegular = /every (\d+) (day|week|month|year)s?(?: on (\w+))?/.test(recurring.pattern);
            const isValidMonthDay = /every (\d+)(?:st|nd|rd|th) of the month/.test(recurring.pattern);
            
            if (!isValidRegular && !isValidMonthDay) {
                return res.status(400).json({ error: 'Invalid recurring pattern format' });
            }
            if (recurring.until && isNaN(new Date(recurring.until).getTime())) {
                return res.status(400).json({ error: 'Invalid until date format' });
            }
        }

        // For recurring transactions with a weekday pattern, adjust the date to the first occurrence
        let adjustedDate = date;
        if (recurring?.pattern) {
            const pattern = parseRecurringPattern(recurring.pattern);
            if (pattern.unit === 'week' && pattern.dayOfWeek) {
                const [year, month, day] = date.split('-');
                const selectedDate = new Date(year, month - 1, day);
                const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
                const targetDay = weekdays.indexOf(pattern.dayOfWeek);
                const currentDay = selectedDate.getDay();
                
                // Calculate days to add to reach the target weekday
                let daysToAdd = targetDay - currentDay;
                if (daysToAdd < 0) {
                    daysToAdd += 7; // Move to next week if target day has passed
                }
                
                // Adjust the date
                selectedDate.setDate(selectedDate.getDate() + daysToAdd);
                adjustedDate = selectedDate.toISOString().split('T')[0];
            } else if (pattern.unit === 'monthday') {
                // For day-of-month pattern, adjust to the first occurrence
                const [year, month] = date.split('-');
                const selectedDate = new Date(year, month - 1, pattern.dayOfMonth);
                
                // If the selected day has passed in the current month, move to next month
                if (selectedDate < new Date(date)) {
                    selectedDate.setMonth(selectedDate.getMonth() + 1);
                }
                
                adjustedDate = selectedDate.toISOString().split('T')[0];
            }
        }

        const transactions = await loadTransactions() || {};
        const [year, month] = adjustedDate.split('-');
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
            description: sanitizeInput(description),
            date: adjustedDate,
            notes: sanitizeInput(notes || '')
        };

        // Add recurring information if present
        if (recurring?.pattern) {
            newTransaction.recurring = {
                pattern: recurring.pattern,
                until: recurring.until || null
            };
        }

        if (type === 'expense') {
            newTransaction.category = sanitizeInput(category);
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

// Helper function to parse recurring pattern
function parseRecurringPattern(pattern) {
    // Try matching the existing pattern first
    const weeklyMatches = pattern.match(/every (\d+) (day|week|month|year)s?(?: on (\w+))?/);
    
    // Try matching the "Nth of month" pattern
    const monthlyDayMatches = pattern.match(/every (\d+)(?:st|nd|rd|th) of the month/);
    
    if (weeklyMatches) {
        const [_, interval, unit, dayOfWeek] = weeklyMatches;
        return {
            interval: parseInt(interval),
            unit: unit.toLowerCase(),
            dayOfWeek: dayOfWeek ? dayOfWeek.toLowerCase() : null
        };
    } else if (monthlyDayMatches) {
        const [_, dayOfMonth] = monthlyDayMatches;
        return {
            interval: 1,
            unit: 'monthday',
            dayOfMonth: parseInt(dayOfMonth)
        };
    }
    
    throw new Error('Invalid recurring pattern');
}

// Helper function to generate recurring instances
function generateRecurringInstances(transaction, startDate, endDate) {
    if (!transaction.recurring?.pattern) return [];
    
    const instances = [];
    const pattern = parseRecurringPattern(transaction.recurring.pattern);
    
    // Convert dates to Date objects for easier manipulation
    const [tYear, tMonth, tDay] = transaction.date.split('-');
    let currentDate = new Date(tYear, tMonth - 1, tDay);
    
    const [sYear, sMonth, sDay] = startDate.split('-');
    const rangeStart = new Date(sYear, sMonth - 1, sDay);
    
    const [eYear, eMonth, eDay] = endDate.split('-');
    const rangeEnd = new Date(eYear, eMonth - 1, eDay);
    
    const until = transaction.recurring.until 
        ? (() => {
            const [uYear, uMonth, uDay] = transaction.recurring.until.split('-');
            return new Date(uYear, uMonth - 1, uDay);
        })()
        : rangeEnd;
    
    // Handle "Nth of month" pattern
    if (pattern.unit === 'monthday') {
        // Set the initial date to the first occurrence
        currentDate = new Date(currentDate.getFullYear(), currentDate.getMonth(), pattern.dayOfMonth);
        if (currentDate < new Date(tYear, tMonth - 1, tDay)) {
            currentDate.setMonth(currentDate.getMonth() + 1);
        }
    }
    // For weekly patterns, ensure we start on the correct day of the week
    else if (pattern.unit === 'week' && pattern.dayOfWeek) {
        const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
        const targetDay = weekdays.indexOf(pattern.dayOfWeek);
        const currentDay = currentDate.getDay();
        
        // Calculate days to add to reach the target weekday
        let daysToAdd = targetDay - currentDay;
        if (daysToAdd < 0) {
            daysToAdd += 7; // Move to next week if target day has passed
        }
        
        // Adjust the start date to the first occurrence
        currentDate.setDate(currentDate.getDate() + daysToAdd);
        
        // For intervals greater than 1, we need to ensure we're starting on the correct week
        if (pattern.interval > 1) {
            // Calculate weeks since the start date
            const weeksSinceStart = Math.floor((currentDate - rangeStart) / (7 * 24 * 60 * 60 * 1000));
            const remainingWeeks = weeksSinceStart % pattern.interval;
            if (remainingWeeks !== 0) {
                // Move forward to the next valid week
                currentDate.setDate(currentDate.getDate() + (pattern.interval - remainingWeeks) * 7);
            }
        }
    }
    
    // Track dates we've already added to prevent duplicates
    const addedDates = new Set();
    
    // Generate instances
    while (currentDate <= until) {
        const dateStr = currentDate.toISOString().split('T')[0];
        
        // Only add if it falls within range and isn't a duplicate
        if (currentDate >= rangeStart && 
            currentDate <= rangeEnd && 
            !addedDates.has(dateStr)) {
            
            instances.push({
                ...transaction,
                id: `${transaction.id}-${dateStr}`,
                date: dateStr,
                isRecurringInstance: true,
                recurringParentId: transaction.id
            });
            
            addedDates.add(dateStr);
        }
        
        // Advance to next occurrence based on interval and unit
        switch (pattern.unit) {
            case 'day':
                currentDate.setDate(currentDate.getDate() + pattern.interval);
                break;
            case 'week':
                currentDate.setDate(currentDate.getDate() + (pattern.interval * 7));
                break;
            case 'month':
                // Don't modify the current date yet
                // Check if we need to handle end-of-month special case
                const originalDay = parseInt(transaction.date.split('-')[2]);
                const daysInCurrentMonth = new Date(
                    currentDate.getFullYear(), 
                    currentDate.getMonth() + 1, 
                    0
                ).getDate();
                
                // Check if the original transaction was on the last day of its month
                const isLastDayOfMonth = originalDay >= daysInCurrentMonth;
                
                // Get the number of days in the target month (after adding interval)
                const daysInTargetMonth = new Date(
                    currentDate.getFullYear(),
                    currentDate.getMonth() + pattern.interval + 1,
                    0
                ).getDate();
                
                // First, create a new date for next month with a safe day value (1)
                const nextMonth = new Date(currentDate);
                nextMonth.setDate(1); // Set to first of month to avoid rollover
                nextMonth.setMonth(nextMonth.getMonth() + pattern.interval);
                
                if (isLastDayOfMonth) {
                    // If original was last day of month, set to last day of target month
                    nextMonth.setDate(daysInTargetMonth);
                } else if (originalDay > daysInTargetMonth) {
                    // If original day doesn't exist in target month, use last day
                    nextMonth.setDate(daysInTargetMonth);
                } else {
                    // Otherwise use the same day of month
                    nextMonth.setDate(originalDay);
                }
                
                // Update current date with our safely constructed date
                currentDate = nextMonth;
                break;
            case 'year':
                currentDate.setFullYear(currentDate.getFullYear() + pattern.interval);
                break;
            case 'monthday':
                // For monthday pattern, move to next month then set the day
                currentDate.setMonth(currentDate.getMonth() + 1);
                
                // Get the last day of the target month
                const lastDayOfMonth = new Date(
                    currentDate.getFullYear(),
                    currentDate.getMonth() + 1,
                    0
                ).getDate();
                
                // If the desired day exceeds the last day, use the last day instead
                if (pattern.dayOfMonth > lastDayOfMonth) {
                    currentDate.setDate(lastDayOfMonth);
                } else {
                    currentDate.setDate(pattern.dayOfMonth);
                }
                break;
        }
    }
    
    return instances;
}

// Update the range endpoint to include recurring instances
app.get(BASE_PATH + '/api/transactions/range', authMiddleware, async (req, res) => {
    try {
        const { start, end } = req.query;
        if (!start || !end) {
            return res.status(400).json({ error: 'Start and end dates are required' });
        }

        // Get transactions with recurring instances already included
        const transactions = await getTransactionsInRange(start, end);
        
        // Sort by date
        transactions.sort((a, b) => new Date(b.date) - new Date(a.date));

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
        const csvRows = ['Date,Type,Category,Description,Notes,Amount'];
        allTransactions.forEach(t => {
            // Escape notes and description to handle commas and quotes
            const escapedDescription = (t.description || '').replace(/"/g, '""');
            const escapedNotes = (t.notes || '').replace(/"/g, '""');
            const formattedDescription = escapedDescription.includes(',') ? `"${escapedDescription}"` : escapedDescription;
            const formattedNotes = escapedNotes.includes(',') ? `"${escapedNotes}"` : escapedNotes;
            
            csvRows.push(`${t.date},${t.type},${t.category || ''},${formattedDescription},${formattedNotes},${t.amount}`);
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
        const csvRows = ['Category,Date,Description,Notes,Value'];
        transactions.forEach(t => {
            const category = t.type === 'income' ? 'Income' : t.category;
            const value = t.type === 'income' ? t.amount : -t.amount;
            // Escape description and notes to handle commas and quotes
            const escapedDescription = (t.description || '').replace(/"/g, '""');
            const escapedNotes = (t.notes || '').replace(/"/g, '""');
            const formattedDescription = escapedDescription.includes(',') ? `"${escapedDescription}"` : escapedDescription;
            const formattedNotes = escapedNotes.includes(',') ? `"${escapedNotes}"` : escapedNotes;
            
            csvRows.push(`${category},${t.date},${formattedDescription},${formattedNotes},${value}`);
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
        const { type, amount, description, category, date, recurring, notes } = req.body;
        
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
                    transaction.category = sanitizeInput(category);
                    monthData.expenses.push({
                        ...transaction,
                        amount: parseFloat(amount),
                        description: sanitizeInput(description),
                        date,
                        recurring: recurring || null,
                        notes: sanitizeInput(notes || '')
                    });
                } else {
                    monthData.income[incomeIndex] = {
                        ...monthData.income[incomeIndex],
                        amount: parseFloat(amount),
                        description: sanitizeInput(description),
                        date,
                        recurring: recurring || null,
                        notes: sanitizeInput(notes || '')
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
                        description: sanitizeInput(description),
                        date,
                        recurring: recurring || null,
                        notes: sanitizeInput(notes || '')
                    });
                } else {
                    monthData.expenses[expenseIndex] = {
                        ...monthData.expenses[expenseIndex],
                        amount: parseFloat(amount),
                        description: sanitizeInput(description),
                        category: sanitizeInput(category),
                        date,
                        recurring: recurring || null,
                        notes: sanitizeInput(notes || '')
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
        
        // Check if this is a recurring instance
        const isRecurringInstance = id.includes('-');
        const parentId = isRecurringInstance ? id.split('-')[0] : id;
        
        // Find and delete the transaction
        for (const key of Object.keys(transactions)) {
            const monthData = transactions[key];
            
            // Check in income array
            const incomeIndex = monthData.income.findIndex(t => 
                t.id === parentId || t.id === id
            );
            if (incomeIndex !== -1) {
                monthData.income.splice(incomeIndex, 1);
                found = true;
                break;
            }
            
            // Check in expenses array
            const expenseIndex = monthData.expenses.findIndex(t => 
                t.id === parentId || t.id === id
            );
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
    res.type('application/javascript');
    res.send(`window.appConfig = {
        debug: ${DEBUG},
        basePath: '${BASE_PATH}',
        title: '${SITE_INSTANCE_TITLE}'
    };`);
});

// API Authentication middleware for DumbCal
const apiAuthMiddleware = (req, res, next) => {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing authorization header' });
    }

    const token = authHeader.split(' ')[1];
    if (token !== process.env.DUMB_SECRET) {
        return res.status(401).json({ error: 'Invalid authorization token' });
    }

    next();
};

// Calendar API endpoint
app.get(BASE_PATH + '/api/calendar/transactions', apiAuthMiddleware, async (req, res) => {
    try {
        const { start_date, end_date } = req.query;

        // Validate date parameters
        if (!start_date || !end_date) {
            return res.status(400).json({ error: 'Missing start_date or end_date parameter' });
        }

        // Validate date format
        const startDate = new Date(start_date);
        const endDate = new Date(end_date);
        
        if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
            return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
        }

        // Load transactions
        const allTransactions = await loadTransactions();
        
        // Filter transactions within date range
        const filteredTransactions = [];
        
        for (const [month, data] of Object.entries(allTransactions)) {
            const monthDate = new Date(month + '-01');
            
            if (monthDate >= startDate && monthDate <= endDate) {
                // Add income transactions
                data.income.forEach(transaction => {
                    filteredTransactions.push({
                        type: 'income',
                        ...transaction,
                        amount: parseFloat(transaction.amount),
                        notes: transaction.notes || ''
                    });
                });
                
                // Add expense transactions
                data.expenses.forEach(transaction => {
                    filteredTransactions.push({
                        type: 'expense',
                        ...transaction,
                        amount: parseFloat(transaction.amount),
                        notes: transaction.notes || ''
                    });
                });
            }
        }

        res.json({ transactions: filteredTransactions });
    } catch (error) {
        console.error('Calendar API error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Add logging to server startup
app.listen(PORT, () => {
    console.log(`Server running on ${BASE_URL}`);
    debugLog('Debug mode enabled');
    debugLog('Base path:', BASE_PATH);
}); 
