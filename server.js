const express = require('express');
const path = require('path');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const Stripe = require('stripe');

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-08-16' })
  : null;
const CURRENCY = 'usd';
const PRICE_PER_SEAT_CENTS = 500;

const app = express();
const PORT = process.env.PORT || 3000;
const dbPath = process.env.DB_PATH
  ? (path.isAbsolute(process.env.DB_PATH) ? process.env.DB_PATH : path.join(__dirname, process.env.DB_PATH))
  : path.join(__dirname, 'ride-sharing.db');
const db = new sqlite3.Database(dbPath);

app.use((req, res, next) => {
  if (req.originalUrl === '/webhook') {
    return next();
  }
  express.json()(req, res, next);
});
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: 'ride-sharing-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax' }
}));

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

function ensureColumn(table, name, definition) {
  return new Promise((resolve, reject) => {
    db.all(`PRAGMA table_info(${table})`, [], (err, rows) => {
      if (err) return reject(err);
      const exists = rows.some((column) => column.name === name);
      if (exists) return resolve();
      db.run(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`, [], (alterError) => {
        if (alterError) return reject(alterError);
        resolve();
      });
    });
  });
}

function geocode(location) {
  const map = {
    Downtown: { lat: 40.7128, lng: -74.0060 },
    Airport: { lat: 40.6413, lng: -73.7781 },
    Uptown: { lat: 40.7870, lng: -73.9754 },
    'Central Park': { lat: 40.7851, lng: -73.9683 },
    Midtown: { lat: 40.7549, lng: -73.9840 },
    Brooklyn: { lat: 40.6782, lng: -73.9442 },
    Queens: { lat: 40.7282, lng: -73.7949 }
  };

  return map[location] || { lat: 40.7306 + (Math.random() - 0.5) * 0.1, lng: -73.9352 + (Math.random() - 0.5) * 0.1 };
}

function calculateProgress(startLat, startLng, endLat, endLng, currentLat, currentLng) {
  if (startLat === 0 && startLng === 0 && endLat === 0 && endLng === 0) {
    return 0;
  }
  const toRad = (value) => (value * Math.PI) / 180;
  const dLat = toRad(endLat - startLat);
  const dLon = toRad(endLng - startLng);
  const aTotal = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(startLat)) * Math.cos(toRad(endLat)) * Math.sin(dLon / 2) ** 2;
  const totalDistance = 2 * Math.atan2(Math.sqrt(aTotal), Math.sqrt(1 - aTotal));
  const dLatCurrent = toRad(currentLat - startLat);
  const dLonCurrent = toRad(currentLng - startLng);
  const aCurrent = Math.sin(dLatCurrent / 2) ** 2 + Math.cos(toRad(startLat)) * Math.cos(toRad(currentLat)) * Math.sin(dLonCurrent / 2) ** 2;
  const currentDistance = 2 * Math.atan2(Math.sqrt(aCurrent), Math.sqrt(1 - aCurrent));
  if (totalDistance === 0) return 0;
  const percent = Math.round(Math.min(100, Math.max(0, (currentDistance / totalDistance) * 100)));
  return percent;
}

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Login required' });
  }
  next();
}

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    email TEXT DEFAULT '',
    email_subscribed INTEGER DEFAULT 0,
    password TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS rides (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    driver_name TEXT NOT NULL,
    from_location TEXT NOT NULL,
    to_location TEXT NOT NULL,
    seats INTEGER NOT NULL,
    booked_seats INTEGER DEFAULT 0,
    route_start_lat REAL DEFAULT 0,
    route_start_lng REAL DEFAULT 0,
    route_end_lat REAL DEFAULT 0,
    route_end_lng REAL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ride_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,    is_paid INTEGER DEFAULT 0,    UNIQUE(ride_id, user_id),
    FOREIGN KEY (ride_id) REFERENCES rides(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS ride_ratings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ride_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    score INTEGER NOT NULL,
    comment TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(ride_id, user_id),
    FOREIGN KEY (ride_id) REFERENCES rides(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS ride_tracking (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ride_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (ride_id) REFERENCES rides(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);

  ensureColumn('users', 'email', "TEXT DEFAULT ''")
    .then(() => ensureColumn('users', 'email_subscribed', 'INTEGER DEFAULT 0'))
    .then(() => ensureColumn('rides', 'route_start_lat', 'REAL DEFAULT 0'))
    .then(() => ensureColumn('rides', 'route_start_lng', 'REAL DEFAULT 0'))
    .then(() => ensureColumn('rides', 'route_end_lat', 'REAL DEFAULT 0'))
    .then(() => ensureColumn('rides', 'route_end_lng', 'REAL DEFAULT 0'))
    .then(() => ensureColumn('bookings', 'is_paid', 'INTEGER DEFAULT 0'))
    .catch(() => {});
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/api/auth/signup', async (req, res) => {
  const { username, email, password, email_updates } = req.body;
  const subscribed = email_updates ? 1 : 0;

  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Username, email, and password are required' });
  }

  if (!email.includes('@')) {
    return res.status(400).json({ error: 'Valid email is required' });
  }

  try {
    const existing = await get('SELECT id FROM users WHERE username = ?', [username]);
    if (existing) {
      return res.status(409).json({ error: 'Username already exists' });
    }

    const existingEmail = await get('SELECT id FROM users WHERE email = ?', [email]);
    if (existingEmail) {
      return res.status(409).json({ error: 'Email already in use' });
    }

    const hashed = await bcrypt.hash(password, 10);
    const result = await run('INSERT INTO users (username, email, email_subscribed, password) VALUES (?, ?, ?, ?)', [username, email, subscribed, hashed]);
    req.session.userId = result.id;
    req.session.username = username;

    res.status(201).json({ user: { id: result.id, username, email, email_subscribed: subscribed } });
  } catch (error) {
    res.status(500).json({ error: 'Signup failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;

  try {
    const user = await get('SELECT id, username, email, email_subscribed, password FROM users WHERE username = ?', [username]);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    req.session.userId = user.id;
    req.session.username = user.username;
    res.json({ user: { id: user.id, username: user.username, email: user.email, email_subscribed: user.email_subscribed } });
  } catch (error) {
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.get('/api/auth/me', async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const user = await get('SELECT id, username, email, email_subscribed FROM users WHERE id = ?', [req.session.userId]);
    res.json({ user });
  } catch (error) {
    res.status(500).json({ error: 'Unable to load user' });
  }
});

app.get('/api/rides', async (req, res) => {
  try {
    const rides = await all(`
      SELECT r.id, r.user_id, r.driver_name, r.from_location, r.to_location, r.seats, r.booked_seats,
             r.route_start_lat, r.route_start_lng, r.route_end_lat, r.route_end_lng,
             r.created_at, u.username AS driver_username,
             COALESCE(AVG(rr.score), 0) AS avg_score,
             COUNT(rr.id) AS rating_count,
             lt.latitude AS latest_latitude,
             lt.longitude AS latest_longitude,
             lt.status AS latest_status
      FROM rides r
      JOIN users u ON u.id = r.user_id
      LEFT JOIN ride_ratings rr ON rr.ride_id = r.id
      LEFT JOIN (
        SELECT rt.*
        FROM ride_tracking rt
        JOIN (
          SELECT ride_id, MAX(id) AS max_id FROM ride_tracking GROUP BY ride_id
        ) latest ON latest.ride_id = rt.ride_id AND latest.max_id = rt.id
      ) lt ON lt.ride_id = r.id
      GROUP BY r.id
      ORDER BY r.created_at DESC
    `);

    const formatted = rides.map((ride) => {
      const currentLocation = typeof ride.latest_latitude === 'number' && typeof ride.latest_longitude === 'number'
        ? {
          latitude: ride.latest_latitude,
          longitude: ride.latest_longitude,
          status: ride.latest_status
        }
        : null;
      const progress = currentLocation
        ? calculateProgress(ride.route_start_lat, ride.route_start_lng, ride.route_end_lat, ride.route_end_lng, ride.latest_latitude, ride.latest_longitude)
        : 0;

      return {
        ...ride,
        available_seats: Math.max(ride.seats - ride.booked_seats, 0),
        average_score: Number(ride.avg_score || 0),
        rating_count: Number(ride.rating_count || 0),
        latest_location: currentLocation,
        progress,
        route_start: {
          latitude: ride.route_start_lat,
          longitude: ride.route_start_lng
        },
        route_end: {
          latitude: ride.route_end_lat,
          longitude: ride.route_end_lng
        }
      };
    });

    res.json(formatted);
  } catch (error) {
    res.status(500).json({ error: 'Unable to load rides' });
  }
});

app.post('/api/rides', requireAuth, async (req, res) => {
  const { from, to, seats } = req.body;

  if (!from || !to || !seats) {
    return res.status(400).json({ error: 'From, to, and seats are required' });
  }

  try {
    const start = geocode(from);
    const end = geocode(to);

    const result = await run(
      'INSERT INTO rides (user_id, driver_name, from_location, to_location, seats, route_start_lat, route_start_lng, route_end_lat, route_end_lng) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [req.session.userId, req.session.username, from, to, Number(seats), start.lat, start.lng, end.lat, end.lng]
    );

    const ride = await get('SELECT * FROM rides WHERE id = ?', [result.id]);
    res.status(201).json({ ride });
  } catch (error) {
    res.status(500).json({ error: 'Unable to create ride' });
  }
});

app.post('/api/rides/:id/book', requireAuth, async (req, res) => {
  const { id } = req.params;

  try {
    const ride = await get('SELECT * FROM rides WHERE id = ?', [id]);
    if (!ride) {
      return res.status(404).json({ error: 'Ride not found' });
    }

    const existingBooking = await get('SELECT id FROM bookings WHERE ride_id = ? AND user_id = ?', [id, req.session.userId]);
    if (existingBooking) {
      return res.status(409).json({ error: 'You already booked this ride' });
    }

    const availableSeats = ride.seats - ride.booked_seats;
    if (availableSeats <= 0) {
      return res.status(400).json({ error: 'No seats available' });
    }

    await run('INSERT INTO bookings (ride_id, user_id, is_paid) VALUES (?, ?, 0)', [id, req.session.userId]);
    await run('UPDATE rides SET booked_seats = booked_seats + 1 WHERE id = ?', [id]);

    res.status(201).json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: 'Booking failed' });
  }
});

app.post('/api/bookings/create-checkout-session', requireAuth, async (req, res) => {
  const { rideId } = req.body;
  if (!Number.isInteger(Number(rideId))) {
    return res.status(400).json({ error: 'Invalid ride id' });
  }

  if (!stripe) {
    return res.status(500).json({ error: 'Stripe is not configured' });
  }

  try {
    const ride = await get('SELECT * FROM rides WHERE id = ?', [rideId]);
    if (!ride) {
      return res.status(404).json({ error: 'Ride not found' });
    }

    const existingBooking = await get('SELECT id, is_paid FROM bookings WHERE ride_id = ? AND user_id = ?', [rideId, req.session.userId]);
    if (existingBooking && existingBooking.is_paid === 1) {
      return res.status(409).json({ error: 'Ride is already booked by this user' });
    }

    const availableSeats = ride.seats - ride.booked_seats;
    if (availableSeats <= 0) {
      return res.status(400).json({ error: 'No seats available' });
    }

    if (!existingBooking) {
      await run('INSERT INTO bookings (ride_id, user_id, is_paid) VALUES (?, ?, 0)', [rideId, req.session.userId]);
      await run('UPDATE rides SET booked_seats = booked_seats + 1 WHERE id = ?', [rideId]);
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: CURRENCY,
            product_data: {
              name: `Ride ${ride.from_location} → ${ride.to_location}`,
              description: `One seat for ${ride.driver_name}`
            },
            unit_amount: PRICE_PER_SEAT_CENTS,
          },
          quantity: 1,
        }
      ],
      metadata: {
        ride_id: String(rideId),
        user_id: String(req.session.userId)
      },
      success_url: `${req.protocol}://${req.get('host')}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${req.protocol}://${req.get('host')}`
    });

    res.json({ url: session.url });
  } catch (error) {
    res.status(500).json({ error: 'Unable to create payment session' });
  }
});

app.post('/api/bookings/confirm-checkout', requireAuth, async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) {
    return res.status(400).json({ error: 'Missing session id' });
  }

  if (!stripe) {
    return res.status(500).json({ error: 'Stripe is not configured' });
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (!session || session.payment_status !== 'paid') {
      return res.status(400).json({ error: 'Payment not completed' });
    }

    const rideId = Number(session.metadata.ride_id);
    if (!Number.isInteger(rideId)) {
      return res.status(400).json({ error: 'Invalid ride metadata' });
    }

    const existingBooking = await get('SELECT id FROM bookings WHERE ride_id = ? AND user_id = ?', [rideId, req.session.userId]);
    if (existingBooking) {
      return res.json({ ok: true, alreadyBooked: true });
    }

    const ride = await get('SELECT * FROM rides WHERE id = ?', [rideId]);
    if (!ride) {
      return res.status(404).json({ error: 'Ride not found' });
    }

    const availableSeats = ride.seats - ride.booked_seats;
    if (availableSeats <= 0) {
      return res.status(400).json({ error: 'No seats available' });
    }

    const result = await run('INSERT INTO bookings (ride_id, user_id, is_paid) VALUES (?, ?, 1)', [rideId, req.session.userId]);
    await run('UPDATE rides SET booked_seats = booked_seats + 1 WHERE id = ?', [rideId]);

    res.json({ ok: true, bookingId: result.id });
  } catch (error) {
    res.status(500).json({ error: 'Unable to confirm booking' });
  }
});

app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) {
    return res.status(500).send('Stripe is not configured');
  }

  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return res.status(500).send('Stripe webhook secret not configured');
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    return res.status(400).send(`Webhook error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const rideId = Number(session.metadata?.ride_id);
    const userId = Number(session.metadata?.user_id);

    if (Number.isInteger(rideId) && Number.isInteger(userId)) {
      try {
        const existingBooking = await get('SELECT id, is_paid FROM bookings WHERE ride_id = ? AND user_id = ?', [rideId, userId]);
        const ride = await get('SELECT * FROM rides WHERE id = ?', [rideId]);
        if (!ride) {
          return;
        }

        if (existingBooking) {
          if (existingBooking.is_paid === 0) {
            await run('UPDATE bookings SET is_paid = 1 WHERE id = ?', [existingBooking.id]);
          }
        } else if (ride.seats - ride.booked_seats > 0) {
          await run('INSERT INTO bookings (ride_id, user_id, is_paid) VALUES (?, ?, 1)', [rideId, userId]);
          await run('UPDATE rides SET booked_seats = booked_seats + 1 WHERE id = ?', [rideId]);
        }
      } catch (err) {
        console.error('Webhook booking error:', err);
      }
    }
  }

  res.json({ received: true });
});

app.get('/api/bookings', requireAuth, async (req, res) => {
  try {
    const bookings = await all(`
      SELECT b.id, b.ride_id, b.created_at, b.is_paid, r.user_id AS ride_owner_id, r.driver_name, r.from_location, r.to_location, r.seats, r.booked_seats
      FROM bookings b
      JOIN rides r ON r.id = b.ride_id
      WHERE b.user_id = ?
      ORDER BY b.created_at DESC
    `, [req.session.userId]);

    res.json(bookings);
  } catch (error) {
    res.status(500).json({ error: 'Unable to load bookings' });
  }
});

app.delete('/api/bookings/:bookingId', requireAuth, async (req, res) => {
  const bookingId = Number(req.params.bookingId);

  if (!Number.isInteger(bookingId)) {
    return res.status(400).json({ error: 'Invalid booking id' });
  }

  try {
    const booking = await get(`
      SELECT b.id, b.ride_id, b.user_id, r.user_id AS ride_owner_id
      FROM bookings b
      JOIN rides r ON r.id = b.ride_id
      WHERE b.id = ?
    `, [bookingId]);

    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    if (booking.ride_owner_id === req.session.userId) {
      return res.status(403).json({ error: 'Drivers cannot cancel customer bookings' });
    }

    if (booking.user_id !== req.session.userId) {
      return res.status(403).json({ error: 'You can only cancel your own bookings' });
    }

    await run('DELETE FROM bookings WHERE id = ?', [bookingId]);
    await run('UPDATE rides SET booked_seats = MAX(booked_seats - 1, 0) WHERE id = ?', [booking.ride_id]);

    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: 'Unable to cancel booking' });
  }
});

app.post('/api/rides/:id/rate', requireAuth, async (req, res) => {
  const rideId = Number(req.params.id);
  const { score, comment } = req.body;

  if (!Number.isInteger(rideId)) {
    return res.status(400).json({ error: 'Invalid ride id' });
  }

  try {
    const booking = await get('SELECT id FROM bookings WHERE ride_id = ? AND user_id = ?', [rideId, req.session.userId]);
    if (!booking) {
      return res.status(403).json({ error: 'Only booked riders can rate a ride' });
    }

    const scoreValue = Math.min(5, Math.max(1, Number(score) || 5));
    const existing = await get('SELECT id FROM ride_ratings WHERE ride_id = ? AND user_id = ?', [rideId, req.session.userId]);

    if (existing) {
      await run('UPDATE ride_ratings SET score = ?, comment = ? WHERE id = ?', [scoreValue, comment || '', existing.id]);
    } else {
      await run('INSERT INTO ride_ratings (ride_id, user_id, score, comment) VALUES (?, ?, ?, ?)', [rideId, req.session.userId, scoreValue, comment || '']);
    }

    const rating = await get('SELECT * FROM ride_ratings WHERE ride_id = ? AND user_id = ?', [rideId, req.session.userId]);
    res.status(201).json({ rating });
  } catch (error) {
    res.status(500).json({ error: 'Unable to save rating' });
  }
});

app.get('/api/rides/:id/ratings', async (req, res) => {
  const rideId = Number(req.params.id);

  if (!Number.isInteger(rideId)) {
    return res.status(400).json({ error: 'Invalid ride id' });
  }

  try {
    const ratings = await all(`
      SELECT rr.id, rr.score, rr.comment, rr.created_at, u.username
      FROM ride_ratings rr
      JOIN users u ON u.id = rr.user_id
      WHERE rr.ride_id = ?
      ORDER BY rr.created_at DESC
    `, [rideId]);

    const averageScore = ratings.length
      ? Number((ratings.reduce((sum, entry) => sum + entry.score, 0) / ratings.length).toFixed(1))
      : 0;

    res.json({ ratings, averageScore });
  } catch (error) {
    res.status(500).json({ error: 'Unable to load ratings' });
  }
});

app.post('/api/rides/:id/location', requireAuth, async (req, res) => {
  const rideId = Number(req.params.id);
  const { latitude, longitude, status } = req.body;

  if (!Number.isInteger(rideId)) {
    return res.status(400).json({ error: 'Invalid ride id' });
  }

  try {
    const ride = await get('SELECT * FROM rides WHERE id = ?', [rideId]);
    if (!ride) {
      return res.status(404).json({ error: 'Ride not found' });
    }

    if (ride.user_id !== req.session.userId) {
      return res.status(403).json({ error: 'Only the driver can update live location' });
    }

    const result = await run(
      'INSERT INTO ride_tracking (ride_id, user_id, latitude, longitude, status) VALUES (?, ?, ?, ?, ?)',
      [rideId, req.session.userId, Number(latitude) || 0, Number(longitude) || 0, status || 'En route']
    );

    const tracking = await get('SELECT * FROM ride_tracking WHERE id = ?', [result.id]);
    res.json({ tracking });
  } catch (error) {
    res.status(500).json({ error: 'Unable to update location' });
  }
});

app.get('/api/rides/:id/location', async (req, res) => {
  const rideId = Number(req.params.id);

  if (!Number.isInteger(rideId)) {
    return res.status(400).json({ error: 'Invalid ride id' });
  }

  try {
    const tracking = await get('SELECT * FROM ride_tracking WHERE ride_id = ? ORDER BY id DESC LIMIT 1', [rideId]);
    res.json({ tracking });
  } catch (error) {
    res.status(500).json({ error: 'Unable to load location' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Ride sharing app listening on port ${PORT}`);
  });
}

module.exports = { app };
