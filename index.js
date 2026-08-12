const express = require('express');
const cors = require('cors');
const SibApiV3Sdk = require('sib-api-v3-sdk');
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

// brevo - send opt Email

const brevoClient = SibApiV3Sdk.ApiClient.instance;
const apiKeyAuth = brevoClient.authentications['api-key'];
apiKeyAuth.apiKey = process.env.BREVO_API_KEY;

const brevoEmailApi = new SibApiV3Sdk.TransactionalEmailsApi();

const sendOtpEmail = async (toEmail, otp) => {
    const email = new SibApiV3Sdk.SendSmtpEmail();

    // This MUST be an email address you verified in Brevo (Settings > Senders).
    email.sender = { name: "Blood Find BD", email: process.env.SENDER_EMAIL };
    email.to = [{ email: toEmail }];
    email.subject = `${otp} is your Blood Find BD verification code`;
    email.textContent = `আপনার Blood Find BD verification code: ${otp}\n\nএই কোডটি ৫ মিনিটের জন্য কার্যকর থাকবে। আপনি যদি এই request না করে থাকেন, এই ইমেইলটি উপেক্ষা করুন।`;
    email.htmlContent = `
        <div style="font-family: sans-serif; max-width: 420px; margin: auto; padding: 24px; border: 1px solid #eee; border-radius: 12px;">
            <h2 style="color:#dc2626; margin-bottom: 4px;">Blood Find BD</h2>
            <p style="color:#333;">আপনার verification code:</p>
            <div style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color:#111; margin: 12px 0;">${otp}</div>
            <p style="color:#666; font-size: 14px;">এই কোডটি ৫ মিনিটের জন্য কার্যকর থাকবে।</p>
            <p style="color:#999; font-size: 12px; margin-top: 20px;">এই request আপনি না করে থাকলে, এই ইমেইলটি উপেক্ষা করুন।</p>
        </div>
    `;

    try {
        await brevoEmailApi.sendTransacEmail(email);
    } catch (err) {
        const message = err?.response?.body?.message || err.message || "Failed to send email via Brevo";
        throw new Error(message);
    }
};

// Collections
let usersCollection;
let bloodRequestsCollection;
let otpCollection;

async function run() {
    try {
        await client.connect();

        const db = client.db("bloodFindDB");
        usersCollection = db.collection("users");
        bloodRequestsCollection = db.collection("bloodRequests");
        otpCollection = db.collection("otps");

        // TTL index — MongoDB auto-deletes OTP documents once `expiresAt` passes
        await otpCollection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });

        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");


        // OTP — email verification during registration

        app.post('/send-otp', async (req, res) => {
            try {
                const { email } = req.body;
                if (!email) {
                    return res.status(400).send({ message: "Email is required" });
                }

                const existingUser = await usersCollection.findOne({ email });
                if (existingUser) {
                    return res.status(409).send({ message: "এই ইমেইল দিয়ে আগেই একাউন্ট আছে" });
                }

                const otp = Math.floor(100000 + Math.random() * 900000).toString();
                const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

                // overwrite any previous pending OTP for this email
                await otpCollection.updateOne(
                    { email },
                    { $set: { email, otp, expiresAt, verified: false } },
                    { upsert: true }
                );

                await sendOtpEmail(email, otp);

                res.send({ message: "OTP sent" });
            } catch (err) {
                console.error("send-otp error:", err);
                res.status(500).send({ message: "OTP পাঠাতে সমস্যা হয়েছে" });
            }
        });

        // Step 2: verify the OTP the user typed in
        app.post('/verify-otp', async (req, res) => {
            try {
                const { email, otp } = req.body;
                if (!email || !otp) {
                    return res.status(400).send({ message: "Email and OTP are required" });
                }

                const record = await otpCollection.findOne({ email });

                if (!record) {
                    return res.status(400).send({ message: "কোনো OTP পাওয়া যায়নি, আবার পাঠান" });
                }
                if (new Date() > new Date(record.expiresAt)) {
                    return res.status(400).send({ message: "OTP এর মেয়াদ শেষ, আবার পাঠান" });
                }
                if (record.otp !== otp) {
                    return res.status(400).send({ message: "ভুল OTP" });
                }

                await otpCollection.updateOne({ email }, { $set: { verified: true } });

                res.send({ message: "OTP verified" });
            } catch (err) {
                console.error("verify-otp error:", err);
                res.status(500).send({ message: "OTP verify করতে সমস্যা হয়েছে" });
            }
        });


        // USERS

        app.post('/users', async (req, res) => {
            try {
                const user = req.body;

                if (!user?.email) {
                    return res.status(400).send({ message: "Email is required" });
                }

                const otpRecord = await otpCollection.findOne({ email: user.email });
                if (!otpRecord || !otpRecord.verified) {
                    return res.status(403).send({ message: "Email verify করা হয়নি" });
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
                    emailVerified: true,
                };

                const result = await usersCollection.insertOne(newUser);

                await otpCollection.deleteOne({ email: user.email });

                res.status(201).send(result);
            } catch (err) {
                console.error(err);
                res.status(500).send({ message: "Failed to create user" });
            }
        });


        // Create a profile the INSTANT a social (Google) sign-in happens.

        app.post('/users/social', async (req, res) => {
            try {
                const user = req.body;

                if (!user?.email) {
                    return res.status(400).send({ message: "Email is required" });
                }

                const existing = await usersCollection.findOne({ email: user.email });
                if (existing) {
                    // already exists — nothing to do, this is fine (e.g. duplicate call)
                    return res.status(200).send(existing);
                }

                const newUser = {
                    name: user.name || "",
                    email: user.email,
                    phone: "",
                    bloodGroup: "",
                    district: "",
                    area: "",
                    gender: "",
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

  
        // existence check — used right after Google sign-in

        app.get('/users/:email/exists', async (req, res) => {
            try {
                const email = req.params.email;
                const user = await usersCollection.findOne({ email }, { projection: { _id: 1 } });
                res.send({ exists: Boolean(user) });
            } catch (err) {
                console.error(err);
                res.status(500).send({ message: "Failed to check user" });
            }
        });

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

        app.patch('/users/:email', async (req, res) => {
            try {
                const email = req.params.email;
                const updates = req.body;

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

        app.get('/donors', async (req, res) => {
            try {
                const { bloodGroup, district, search } = req.query;

                const query = { available: true };
                if (bloodGroup) query.bloodGroup = bloodGroup;
                if (district) query.district = district;

                
                if (search) {
                    const escaped = search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                    const regex = new RegExp(escaped, "i");
                    query.$or = [
                        { name: regex },
                        { district: regex },
                        { area: regex },
                        { bloodGroup: regex },
                    ];
                }

                const donors = await usersCollection
                    .find(query)
                    .project({ email: 1, name: 1, phone: 1, bloodGroup: 1, district: 1, area: 1, photoURL: 1 })
                    .limit(50)
                    .toArray();

                res.send(donors);
            } catch (err) {
                console.error(err);
                res.status(500).send({ message: "Failed to fetch donors" });
            }
        });



        // BLOOD REQUESTS

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
                    urgency: request.urgency || "normal",
                    status: "open",
                    createdAt: new Date(),
                };

                const result = await bloodRequestsCollection.insertOne(newRequest);
                res.status(201).send(result);
            } catch (err) {
                console.error(err);
                res.status(500).send({ message: "Failed to create request" });
            }
        });

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
}
run();

app.get('/', (req, res) => {
    res.send('Blood Find Server Running');
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});