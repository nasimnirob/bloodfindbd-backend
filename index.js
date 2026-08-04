const express = require('express');
const cors = require('cors');
require("dotenv").config();

const app = express();
const port = process.env.PORT || 5000;

const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const uri = `mongodb+srv://${process.env.DB_USER}:${encodeURIComponent(process.env.DB_PASS)}@cluster0.z4s6olo.mongodb.net/?appName=Cluster0`;

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

app.use(cors());
app.use(express.json());

// Collections — assigned once the client connects, then reused by every route
let usersCollection;
let bloodRequestsCollection;

async function run() {
    try {
        await client.connect();

        const db = client.db("bloodFindDB");
        usersCollection = db.collection("users");
        bloodRequestsCollection = db.collection("bloodRequests");

        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");

        // ---------------------------------------------------------------
        // USERS
        // ---------------------------------------------------------------

        // Create a user profile (called right after firebase register)
        app.post('/users', async (req, res) => {
            try {
                const user = req.body;

                if (!user?.email) {
                    return res.status(400).send({ message: "Email is required" });
                }

                const existing = await usersCollection.findOne({ email: user.email });
                if (existing) {
                    return res.status(409).send({ message: "User already exists" });
                }

                const newUser = {
                    name: user.name || "",
                    email: user.email,
                    phone: user.phone || "",
                    bloodGroup: user.bloodGroup || "",
                    district: user.district || "",
                    area: user.area || "",
                    gender: user.gender || "",
                    photoURL: user.photoURL || "",
                    available: true,
                    totalDonations: 0,
                    lastDonation: null,
                    createdAt: new Date(),
                };

                const result = await usersCollection.insertOne(newUser);
                res.status(201).send(result);
            } catch (err) {
                console.error(err);
                res.status(500).send({ message: "Failed to create user" });
            }
        });

        // Get a single user's profile by email
        app.get('/users/:email', async (req, res) => {
            try {
                const email = req.params.email;
                const user = await usersCollection.findOne({ email });

                if (!user) {
                    return res.status(404).send({ message: "User not found" });
                }

                res.send(user);
            } catch (err) {
                console.error(err);
                res.status(500).send({ message: "Failed to fetch user" });
            }
        });

        // Update profile fields (name, phone, bloodGroup, district, area, gender)
        app.patch('/users/:email', async (req, res) => {
            try {
                const email = req.params.email;
                const updates = req.body;

                // never allow these to be overwritten through this route
                delete updates.email;
                delete updates.totalDonations;
                delete updates.createdAt;

                const result = await usersCollection.updateOne(
                    { email },
                    { $set: updates }
                );

                if (result.matchedCount === 0) {
                    return res.status(404).send({ message: "User not found" });
                }

                res.send(result);
            } catch (err) {
                console.error(err);
                res.status(500).send({ message: "Failed to update user" });
            }
        });

        // Toggle donor availability
        app.patch('/users/:email/availability', async (req, res) => {
            try {
                const email = req.params.email;
                const { available } = req.body;

                const result = await usersCollection.updateOne(
                    { email },
                    { $set: { available: Boolean(available) } }
                );

                if (result.matchedCount === 0) {
                    return res.status(404).send({ message: "User not found" });
                }

                res.send(result);
            } catch (err) {
                console.error(err);
                res.status(500).send({ message: "Failed to update availability" });
            }
        });

        // Search available donors (blood group / district) — used by "Available Donors" page
        app.get('/donors', async (req, res) => {
            try {
                const { bloodGroup, district } = req.query;

                const query = { available: true };
                if (bloodGroup) query.bloodGroup = bloodGroup;
                if (district) query.district = district;

                const donors = await usersCollection
                    .find(query)
                    .project({ email: 1, name: 1, phone: 1, bloodGroup: 1, district: 1, area: 1, photoURL: 1 })
                    .toArray();

                res.send(donors);
            } catch (err) {
                console.error(err);
                res.status(500).send({ message: "Failed to fetch donors" });
            }
        });

        // ---------------------------------------------------------------
        // BLOOD REQUESTS
        // ---------------------------------------------------------------

        // Create a new blood request ("I Need Blood" form)
        app.post('/blood-requests', async (req, res) => {
            try {
                const request = req.body;

                const requiredFields = ["patientName", "bloodGroup", "district", "contactPhone"];
                const missing = requiredFields.filter((f) => !request?.[f]);
                if (missing.length) {
                    return res.status(400).send({ message: `Missing fields: ${missing.join(", ")}` });
                }

                const newRequest = {
                    patientName: request.patientName,
                    bloodGroup: request.bloodGroup,
                    district: request.district,
                    area: request.area || "",
                    hospital: request.hospital || "",
                    contactPhone: request.contactPhone,
                    requesterEmail: request.requesterEmail || "",
                    unitsNeeded: Number(request.unitsNeeded) || 1,
                    urgency: request.urgency || "normal", // "urgent" | "normal"
                    status: "open", // "open" | "fulfilled" | "cancelled"
                    createdAt: new Date(),
                };

                const result = await bloodRequestsCollection.insertOne(newRequest);
                res.status(201).send(result);
            } catch (err) {
                console.error(err);
                res.status(500).send({ message: "Failed to create request" });
            }
        });

        // List blood requests (optionally filter by bloodGroup / district / status)
        app.get('/blood-requests', async (req, res) => {
            try {
                const { bloodGroup, district, status } = req.query;

                const query = {};
                if (bloodGroup) query.bloodGroup = bloodGroup;
                if (district) query.district = district;
                if (status) query.status = status;

                const requests = await bloodRequestsCollection
                    .find(query)
                    .sort({ createdAt: -1 })
                    .toArray();

                res.send(requests);
            } catch (err) {
                console.error(err);
                res.status(500).send({ message: "Failed to fetch requests" });
            }
        });

        // Single request details
        app.get('/blood-requests/:id', async (req, res) => {
            try {
                const id = req.params.id;

                if (!ObjectId.isValid(id)) {
                    return res.status(400).send({ message: "Invalid request id" });
                }

                const request = await bloodRequestsCollection.findOne({ _id: new ObjectId(id) });

                if (!request) {
                    return res.status(404).send({ message: "Request not found" });
                }

                res.send(request);
            } catch (err) {
                console.error(err);
                res.status(500).send({ message: "Failed to fetch request" });
            }
        });

        // Update a request's status (fulfilled / cancelled)
        app.patch('/blood-requests/:id/status', async (req, res) => {
            try {
                const id = req.params.id;
                const { status } = req.body;

                if (!ObjectId.isValid(id)) {
                    return res.status(400).send({ message: "Invalid request id" });
                }
                if (!["open", "fulfilled", "cancelled"].includes(status)) {
                    return res.status(400).send({ message: "Invalid status value" });
                }

                const result = await bloodRequestsCollection.updateOne(
                    { _id: new ObjectId(id) },
                    { $set: { status } }
                );

                if (result.matchedCount === 0) {
                    return res.status(404).send({ message: "Request not found" });
                }

                res.send(result);
            } catch (err) {
                console.error(err);
                res.status(500).send({ message: "Failed to update request" });
            }
        });

    } catch (err) {
        console.error("Failed to connect to MongoDB:", err);
    }
    // NOTE: client.close() is intentionally NOT called here.
    // The connection must stay open for the lifetime of the server —
    // closing it right after connecting (as in the original code) would
    // break every route that touches the database.
}
run();

app.get('/', (req, res) => {
    res.send('Blood Find Server Running');
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});


// const express = require('express');
// const cors = require('cors');
// require("dotenv").config();

// const app = express();
// const port = 5000;

// const { MongoClient, ServerApiVersion } = require('mongodb');
// const uri = `mongodb+srv://${process.env.DB_USER}:${encodeURIComponent(process.env.DB_PASS)}@cluster0.z4s6olo.mongodb.net/?appName=Cluster0`;

// // Create a MongoClient with a MongoClientOptions object to set the Stable API version
// const client = new MongoClient(uri, {
//     serverApi: {
//         version: ServerApiVersion.v1,
//         strict: true,
//         deprecationErrors: true,
//     }
// });

// async function run() {
//     try {
//         // Connect the client to the server	(optional starting in v4.7)
//         await client.connect();
//         // Send a ping to confirm a successful connection
//         await client.db("admin").command({ ping: 1 });
//         console.log("Pinged your deployment. You successfully connected to MongoDB!");
//     } finally {
//         // Ensures that the client will close when you finish/error
//         await client.close();
//     }
// }
// run().catch(console.dir);

// app.use(cors());
// app.use(express.json());

// app.get('/', (req, res) => {
//     res.send('Blood Find Server Running');
// });

// app.listen(port, () => {
//     console.log(`Server running on port ${port}`);
// });


// app.post('/donors', async (req, res) => {
//     const donor = req.body;
//     const result = await donorsCollection.insertOne(donor);
//     res.send(result);
// });


// app.get('/donors/search', async (req, res) => {
//     const { bloodGroup, district } = req.query;

//     const query = {};

//     if (bloodGroup) query.bloodGroup = bloodGroup;
//     if (district) query.district = district;

//     const result = await donorsCollection.find(query).toArray();
//     res.send(result);
// });