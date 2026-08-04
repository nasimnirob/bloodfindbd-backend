const express = require('express');
const cors = require('cors');
require("dotenv").config();

const app = express();
const port = 5000;

const { MongoClient, ServerApiVersion } = require('mongodb');
const uri = `mongodb+srv://${process.env.DB_USER}:${encodeURIComponent(process.env.DB_PASS)}@cluster0.z4s6olo.mongodb.net/?appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

async function run() {
    try {
        // Connect the client to the server	(optional starting in v4.7)
        await client.connect();
        // Send a ping to confirm a successful connection
        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");
    } finally {
        // Ensures that the client will close when you finish/error
        await client.close();
    }
}
run().catch(console.dir);

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
    res.send('Blood Find Server Running');
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});


app.post('/donors', async (req, res) => {
    const donor = req.body;
    const result = await donorsCollection.insertOne(donor);
    res.send(result);
});


app.get('/donors/search', async (req, res) => {
    const { bloodGroup, district } = req.query;

    const query = {};

    if (bloodGroup) query.bloodGroup = bloodGroup;
    if (district) query.district = district;

    const result = await donorsCollection.find(query).toArray();
    res.send(result);
});