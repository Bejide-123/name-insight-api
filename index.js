const express = require('express');
const axios = require('axios');
const cors = require('cors');
const Database = require('better-sqlite3');
const { v7: uuidv7 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json());

// Initialize SQLite database
const db = new Database('profiles.db');

// Create table if it doesn't exist
db.exec(`
  CREATE TABLE IF NOT EXISTS profiles (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    gender TEXT NOT NULL,
    gender_probability REAL NOT NULL,
    sample_size INTEGER NOT NULL,
    age INTEGER NOT NULL,
    age_group TEXT NOT NULL,
    country_id TEXT NOT NULL,
    country_probability REAL NOT NULL,
    created_at TEXT NOT NULL
  )
`);

// Helper function to determine age group
function getAgeGroup(age) {
  if (age <= 12) return 'child';
  if (age <= 19) return 'teenager';
  if (age <= 59) return 'adult';
  return 'senior';
}

// Helper function to call all 3 APIs
async function fetchNameData(name) {
  try {
    // Call all 3 APIs in parallel
    const [genderRes, ageRes, nationalizeRes] = await Promise.all([
      axios.get(`https://api.genderize.io?name=${encodeURIComponent(name)}`),
      axios.get(`https://api.agify.io?name=${encodeURIComponent(name)}`),
      axios.get(`https://api.nationalize.io?name=${encodeURIComponent(name)}`)
    ]);

    const genderData = genderRes.data;
    const ageData = ageRes.data;
    const nationalizeData = nationalizeRes.data;

    // Check Genderize API validity
    if (genderData.gender === null || genderData.count === 0) {
      return { error: 'Genderize returned an invalid response' };
    }

    // Check Agify API validity
    if (ageData.age === null) {
      return { error: 'Agify returned an invalid response' };
    }

    // Check Nationalize API validity
    if (!nationalizeData.country || nationalizeData.country.length === 0) {
      return { error: 'Nationalize returned an invalid response' };
    }

    // Get country with highest probability
    const topCountry = nationalizeData.country.reduce((prev, current) => 
      (prev.probability > current.probability) ? prev : current
    );

    const ageGroup = getAgeGroup(ageData.age);

    return {
      success: true,
      data: {
        gender: genderData.gender,
        gender_probability: genderData.probability,
        sample_size: genderData.count,
        age: ageData.age,
        age_group: ageGroup,
        country_id: topCountry.country_id,
        country_probability: topCountry.probability
      }
    };

  } catch (error) {
    console.error('API Error:', error.message);
    return { error: 'Upstream or server failure' };
  }
}

// ENDPOINT 1: Create Profile (POST /api/profiles)
app.post('/api/profiles', async (req, res) => {
  try {
    const { name } = req.body;

    // Validate name
    if (!name || name.trim() === '') {
      return res.status(400).json({
        status: 'error',
        message: 'Missing or empty name'
      });
    }

    if (typeof name !== 'string') {
      return res.status(422).json({
        status: 'error',
        message: 'Invalid type'
      });
    }

    const trimmedName = name.trim().toLowerCase();

    // Check if profile already exists
    const existing = db.prepare('SELECT * FROM profiles WHERE name = ?').get(trimmedName);
    
    if (existing) {
      return res.status(200).json({
        status: 'success',
        message: 'Profile already exists',
        data: existing
      });
    }

    // Fetch data from external APIs
    const apiResult = await fetchNameData(trimmedName);

    if (apiResult.error) {
      return res.status(502).json({
        status: 'error',
        message: apiResult.error
      });
    }

    // Create new profile with UUID v7
    const id = uuidv7();
    const now = new Date().toISOString();

    const profile = {
      id,
      name: trimmedName,
      ...apiResult.data,
      created_at: now
    };

    // Insert into database
    const stmt = db.prepare(`
      INSERT INTO profiles (id, name, gender, gender_probability, sample_size, age, age_group, country_id, country_probability, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      profile.id,
      profile.name,
      profile.gender,
      profile.gender_probability,
      profile.sample_size,
      profile.age,
      profile.age_group,
      profile.country_id,
      profile.country_probability,
      profile.created_at
    );

    res.status(201).json({
      status: 'success',
      data: profile
    });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error'
    });
  }
});

// ENDPOINT 2: Get Single Profile (GET /api/profiles/:id)
app.get('/api/profiles/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(id);

    if (!profile) {
      return res.status(404).json({
        status: 'error',
        message: 'Profile not found'
      });
    }

    res.status(200).json({
      status: 'success',
      data: profile
    });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error'
    });
  }
});

// ENDPOINT 3: Get All Profiles with Filters (GET /api/profiles)
app.get('/api/profiles', async (req, res) => {
  try {
    const { gender, country_id, age_group } = req.query;
    
    let query = 'SELECT id, name, gender, age, age_group, country_id FROM profiles WHERE 1=1';
    const params = [];

    // Add filters (case-insensitive)
    if (gender) {
      query += ' AND LOWER(gender) = LOWER(?)';
      params.push(gender);
    }

    if (country_id) {
      query += ' AND LOWER(country_id) = LOWER(?)';
      params.push(country_id);
    }

    if (age_group) {
      query += ' AND LOWER(age_group) = LOWER(?)';
      params.push(age_group);
    }

    query += ' ORDER BY created_at DESC';

    const profiles = db.prepare(query).all(params);

    res.status(200).json({
      status: 'success',
      count: profiles.length,
      data: profiles
    });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error'
    });
  }
});

// ENDPOINT 4: Delete Profile (DELETE /api/profiles/:id)
app.delete('/api/profiles/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(id);

    if (!profile) {
      return res.status(404).json({
        status: 'error',
        message: 'Profile not found'
      });
    }

    db.prepare('DELETE FROM profiles WHERE id = ?').run(id);

    res.status(204).send();

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error'
    });
  }
});

// For local testing
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

// For Vercel
module.exports = app;