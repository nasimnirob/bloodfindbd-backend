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
                    role: "user",
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
                    role: "user",
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

        // Update User Current Location

        app.patch('/users/:email/location', async (req, res) => {
            try {
                const email = req.params.email.trim().toLowerCase();

                const { lat, lng, area, district, locationName } = req.body;

                // Validate latitude and longitude
                if (
                    typeof lat !== "number" ||
                    typeof lng !== "number" ||
                    lat < -90 ||
                    lat > 90 ||
                    lng < -180 ||
                    lng > 180
                ) {
                    return res.status(400).send({
                        message: "Valid latitude and longitude are required"
                    });
                }

                const result = await usersCollection.updateOne(
                    { email },
                    {
                        $set: {
                            location: {
                                lat,
                                lng
                            },
                            area: area || "",
                            district: district || "",
                            locationName: locationName || "",
                            locationUpdatedAt: new Date()
                        }
                    }
                );

                if (result.matchedCount === 0) {
                    return res.status(404).send({
                        message: "User not found"
                    });
                }

                res.send({
                    message: "Current location updated successfully",
                    modifiedCount: result.modifiedCount
                });

            } catch (error) {
                console.error("Location update error:", error);

                res.status(500).send({
                    message: "Failed to update current location"
                });
            }
        });

        // app.get('/donors', async (req, res) => {
        //     try {
        //         const { bloodGroup, district, search } = req.query;

        //         const query = { available: true };
        //         if (bloodGroup) query.bloodGroup = bloodGroup;
        //         if (district) query.district = district;


        //         if (search) {
        //             const escaped = search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        //             const regex = new RegExp(escaped, "i");
        //             query.$or = [
        //                 { name: regex },
        //                 { district: regex },
        //                 { area: regex },
        //                 { bloodGroup: regex },
        //             ];
        //         }

        //         const donors = await usersCollection
        //             .find(query)
        //             .project({ email: 1, name: 1, phone: 1, bloodGroup: 1, district: 1, area: 1, photoURL: 1 })
        //             .limit(50)
        //             .toArray();

        //         res.send(donors);
        //     } catch (err) {
        //         console.error(err);
        //         res.status(500).send({ message: "Failed to fetch donors" });
        //     }
        // });


        // user post count


        app.get("/donors", async (req, res) => {
            try {
                const {
                    bloodGroup,
                    district,
                    search,
                    lat,
                    lng,
                    radius = 50,
                } = req.query;

                const query = {
                    available: true,
                };

                if (bloodGroup) {
                    query.bloodGroup = bloodGroup;
                }

                if (district) {
                    query.district = district;
                }

                if (search) {
                    const escaped = search
                        .trim()
                        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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
                    .project({
                        email: 1,
                        name: 1,
                        phone: 1,
                        bloodGroup: 1,
                        district: 1,
                        area: 1,
                        photoURL: 1,
                        location: 1,
                    })
                    .limit(200)
                    .toArray();

                // Near Me filtering

                if (lat && lng) {
                    const userLat = Number(lat);
                    const userLng = Number(lng);
                    const maxRadius = Number(radius);

                    if (
                        Number.isNaN(userLat) ||
                        Number.isNaN(userLng)
                    ) {
                        return res.status(400).send({
                            message: "Invalid location",
                        });
                    }

                    const toRadians = (degree) =>
                        (degree * Math.PI) / 180;

                    const calculateDistance = (
                        lat1,
                        lng1,
                        lat2,
                        lng2
                    ) => {
                        const earthRadius = 6371;

                        const dLat = toRadians(lat2 - lat1);
                        const dLng = toRadians(lng2 - lng1);

                        const a =
                            Math.sin(dLat / 2) *
                            Math.sin(dLat / 2) +
                            Math.cos(toRadians(lat1)) *
                            Math.cos(toRadians(lat2)) *
                            Math.sin(dLng / 2) *
                            Math.sin(dLng / 2);

                        const c =
                            2 *
                            Math.atan2(
                                Math.sqrt(a),
                                Math.sqrt(1 - a)
                            );

                        return earthRadius * c;
                    };

                    const nearbyDonors = donors
                        .map((donor) => {
                            const donorLat = donor.location?.lat;
                            const donorLng = donor.location?.lng;

                            if (
                                typeof donorLat !== "number" ||
                                typeof donorLng !== "number"
                            ) {
                                return null;
                            }

                            const distance = calculateDistance(
                                userLat,
                                userLng,
                                donorLat,
                                donorLng
                            );

                            return {
                                ...donor,
                                distance: Number(
                                    distance.toFixed(2)
                                ),
                            };
                        })
                        .filter(
                            (donor) =>
                                donor &&
                                donor.distance <= maxRadius
                        )
                        .sort(
                            (a, b) =>
                                a.distance - b.distance
                        );

                    return res.send(nearbyDonors);
                }

                // Normal donor search
                res.send(donors);
            } catch (err) {
                console.error(err);

                res.status(500).send({
                    message: "Failed to fetch donors",
                });
            }
        });

        app.get('/users/:email/post-count', async (req, res) => {
            try {
                const email = req.params.email.trim().toLowerCase();

                const count = await bloodRequestsCollection.countDocuments({
                    requesterEmail: email
                });

                res.send({ count });

            } catch (err) {
                console.error("post-count error:", err);
                res.status(500).send({
                    message: "Failed to get post count"
                });
            }
        });


        app.get('/blood-requests/user/:email', async (req, res) => {
            try {
                const email = req.params.email.trim().toLowerCase();

                const posts = await bloodRequestsCollection
                    .find({
                        requesterEmail: email
                    })
                    .sort({ createdAt: -1 })
                    .toArray();

                res.send(posts);

            } catch (err) {
                console.error("user posts error:", err);

                res.status(500).send({
                    message: "Failed to fetch user posts"
                });
            }
        });


        ///////////// ADMIN START ////////////

        app.get('/admin/dashboard', async (req, res) => {
            try {
                const [
                    totalUsers,
                    totalDonors,
                    totalRequests,
                    openRequests,
                    fulfilledRequests,
                    cancelledRequests
                ] = await Promise.all([
                    usersCollection.countDocuments(),

                    usersCollection.countDocuments({
                        available: true
                    }),

                    bloodRequestsCollection.countDocuments(),

                    bloodRequestsCollection.countDocuments({
                        status: "open"
                    }),

                    bloodRequestsCollection.countDocuments({
                        status: "fulfilled"
                    }),

                    bloodRequestsCollection.countDocuments({
                        status: "cancelled"
                    })
                ]);

                // Blood group statistics
                const bloodGroupStats = await usersCollection.aggregate([
                    {
                        $match: {
                            available: true,
                            bloodGroup: { $ne: "" }
                        }
                    },
                    {
                        $group: {
                            _id: "$bloodGroup",
                            count: { $sum: 1 }
                        }
                    },
                    {
                        $sort: {
                            count: -1
                        }
                    }
                ]).toArray();

                // District statistics
                const districtStats = await usersCollection.aggregate([
                    {
                        $match: {
                            district: { $ne: "" }
                        }
                    },
                    {
                        $group: {
                            _id: "$district",
                            count: { $sum: 1 }
                        }
                    },
                    {
                        $sort: {
                            count: -1
                        }
                    },
                    {
                        $limit: 10
                    }
                ]).toArray();

                // Recent users
                const recentUsers = await usersCollection
                    .find({})
                    .project({
                        name: 1,
                        email: 1,
                        bloodGroup: 1,
                        district: 1,
                        available: 1,
                        photoURL: 1,
                        createdAt: 1
                    })
                    .sort({
                        createdAt: -1
                    })
                    .limit(5)
                    .toArray();

                // Recent blood requests
                const recentRequests = await bloodRequestsCollection
                    .find({})
                    .sort({
                        createdAt: -1
                    })
                    .limit(5)
                    .toArray();

                res.send({
                    statistics: {
                        totalUsers,
                        totalDonors,
                        totalRequests,
                        openRequests,
                        fulfilledRequests,
                        cancelledRequests
                    },

                    bloodGroupStats,

                    districtStats,

                    recentUsers,

                    recentRequests
                });

            } catch (err) {
                console.error("Dashboard error:", err);

                res.status(500).send({
                    message: "Failed to load dashboard data"
                });
            }
        });


        // ADMIN USER

        app.get('/admin/users', async (req, res) => {
            try {
                const { search, bloodGroup, district } = req.query;

                const query = {};

                if (bloodGroup) {
                    query.bloodGroup = bloodGroup;
                }

                if (district) {
                    query.district = district;
                }

                if (search) {
                    const regex = new RegExp(
                        search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
                        "i"
                    );

                    query.$or = [
                        { name: regex },
                        { email: regex },
                        { phone: regex },
                        { district: regex },
                        { area: regex },
                        { bloodGroup: regex }
                    ];
                }

                const users = await usersCollection
                    .find(query)
                    .project({
                        name: 1,
                        email: 1,
                        phone: 1,
                        bloodGroup: 1,
                        district: 1,
                        area: 1,
                        gender: 1,
                        photoURL: 1,
                        available: 1,
                        totalDonations: 1,
                        lastDonation: 1,
                        createdAt: 1,
                        role: 1
                    })
                    .sort({
                        createdAt: -1
                    })
                    .toArray();

                res.send(users);

            } catch (err) {
                console.error("Admin users error:", err);

                res.status(500).send({
                    message: "Failed to fetch users"
                });
            }
        });

        // ADMIN USER DELETE

        app.delete('/admin/users/:id', async (req, res) => {
            try {
                const id = req.params.id;

                if (!ObjectId.isValid(id)) {
                    return res.status(400).send({
                        message: "Invalid user id"
                    });
                }

                const result = await usersCollection.deleteOne({
                    _id: new ObjectId(id)
                });

                if (result.deletedCount === 0) {
                    return res.status(404).send({
                        message: "User not found"
                    });
                }

                res.send({
                    message: "User deleted successfully",
                    deletedCount: result.deletedCount
                });

            } catch (err) {
                console.error("Admin delete user error:", err);

                res.status(500).send({
                    message: "Failed to delete user"
                });
            }
        });


        // ADMIN BLOOD REQUEST

        app.get('/admin/blood-requests', async (req, res) => {
            try {
                const { search, bloodGroup, district, status } = req.query;

                const query = {};

                if (bloodGroup) {
                    query.bloodGroup = bloodGroup;
                }

                if (district) {
                    query.district = district;
                }

                if (status) {
                    query.status = status;
                }

                if (search) {
                    const regex = new RegExp(
                        search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
                        "i"
                    );

                    query.$or = [
                        { patientName: regex },
                        { patientProblem: regex },
                        { hospital: regex },
                        { district: regex },
                        { area: regex },
                        { requesterEmail: regex },
                        { contactPhone: regex }
                    ];
                }

                const requests = await bloodRequestsCollection
                    .find(query)
                    .sort({
                        createdAt: -1
                    })
                    .toArray();

                res.send(requests);

            } catch (err) {
                console.error("Admin requests error:", err);

                res.status(500).send({
                    message: "Failed to fetch blood requests"
                });
            }
        });


        // ADMIN REQUEST DELETE

        app.delete('/admin/blood-requests/:id', async (req, res) => {
            try {
                const id = req.params.id;

                if (!ObjectId.isValid(id)) {
                    return res.status(400).send({
                        message: "Invalid request id"
                    });
                }

                const result = await bloodRequestsCollection.deleteOne({
                    _id: new ObjectId(id)
                });

                if (result.deletedCount === 0) {
                    return res.status(404).send({
                        message: "Request not found"
                    });
                }

                res.send({
                    message: "Blood request deleted successfully"
                });

            } catch (err) {
                console.error("Admin delete request error:", err);

                res.status(500).send({
                    message: "Failed to delete request"
                });
            }
        });


        // SUPER ADMIN

        app.patch('/admin/users/:id/role', async (req, res) => {
            try {
                const id = req.params.id;
                const { role } = req.body;

                if (!ObjectId.isValid(id)) {
                    return res.status(400).send({
                        message: "Invalid user id"
                    });
                }

                if (!["user", "admin"].includes(role)) {
                    return res.status(400).send({
                        message: "Invalid role"
                    });
                }

                const result = await usersCollection.updateOne(
                    {
                        _id: new ObjectId(id)
                    },
                    {
                        $set: {
                            role: role
                        }
                    }
                );

                if (result.matchedCount === 0) {
                    return res.status(404).send({
                        message: "User not found"
                    });
                }

                res.send({
                    message: `User role changed to ${role}`,
                    modifiedCount: result.modifiedCount
                });

            } catch (error) {
                console.error("Role update error:", error);

                res.status(500).send({
                    message: "Failed to update user role"
                });
            }
        });

        ///////////////// ADMIN END ///////////////////


        // BLOOD REQUESTS

        app.post('/blood-requests', async (req, res) => {
            try {
                const request = req.body;

                const requiredFields = ["patientProblem", "bloodGroup", "contactPhone"];
                const missing = requiredFields.filter((f) => !request?.[f]);
                if (missing.length) {
                    return res.status(400).send({ message: `Missing fields: ${missing.join(", ")}` });
                }

                const newRequest = {
                    patientName: request.patientName,
                    patientProblem: request.patientProblem,
                    bloodGroup: request.bloodGroup,
                    district: request.district,
                    area: request.area || "",
                    location: request.location && request.location.lat && request.location.lng
                        ? { lat: request.location.lat, lng: request.location.lng }
                        : null,
                    hospital: request.hospital || "",
                    contactPhone: request.contactPhone,
                    // requesterEmail: request.requesterEmail || "",
                    requesterEmail: request.requesterEmail?.trim().toLowerCase() || "",
                    unitsNeeded: Number(request.unitsNeeded) || 1,
                    urgency: request.urgency || "normal",
                    neededOn: request.neededOn || null,
                    note: request.note || "",
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


        // UPDATE USER'S OWN BLOOD REQUEST
        app.patch('/blood-requests/:id', async (req, res) => {
            try {
                const id = req.params.id;
                const email = req.query.email?.trim().toLowerCase();

                if (!ObjectId.isValid(id)) {
                    return res.status(400).send({
                        message: "Invalid request id"
                    });
                }

                if (!email) {
                    return res.status(400).send({
                        message: "User email is required"
                    });
                }

                const {
                    patientName,
                    patientProblem,
                    bloodGroup,
                    district,
                    area,
                    location,
                    hospital,
                    contactPhone,
                    unitsNeeded,
                    urgency,
                    neededOn,
                    note
                } = req.body;

                const updates = {
                    patientName: patientName || "",
                    patientProblem: patientProblem || "",
                    bloodGroup: bloodGroup || "",
                    district: district || "",
                    area: area || "",
                    location: location || null,
                    hospital: hospital || "",
                    contactPhone: contactPhone || "",
                    unitsNeeded: Number(unitsNeeded) || 1,
                    urgency: urgency || "normal",
                    neededOn: neededOn || null,
                    note: note || "",
                    updatedAt: new Date()
                };

                const result = await bloodRequestsCollection.updateOne(
                    {
                        _id: new ObjectId(id),
                        requesterEmail: email
                    },
                    {
                        $set: updates
                    }
                );

                if (result.matchedCount === 0) {
                    return res.status(404).send({
                        message: "Post not found or you are not allowed to edit this post"
                    });
                }

                res.send({
                    message: "Post updated successfully",
                    modifiedCount: result.modifiedCount
                });

            } catch (err) {
                console.error("Update post error:", err);

                res.status(500).send({
                    message: "Failed to update post"
                });
            }
        });


        // DELETE USER'S OWN BLOOD REQUEST
        app.delete('/blood-requests/:id', async (req, res) => {
            try {
                const id = req.params.id;
                const email = req.query.email?.trim().toLowerCase();

                if (!ObjectId.isValid(id)) {
                    return res.status(400).send({
                        message: "Invalid request id"
                    });
                }

                if (!email) {
                    return res.status(400).send({
                        message: "User email is required"
                    });
                }

                const result = await bloodRequestsCollection.deleteOne({
                    _id: new ObjectId(id),
                    requesterEmail: email
                });

                if (result.deletedCount === 0) {
                    return res.status(404).send({
                        message: "Post not found or you are not allowed to delete this post"
                    });
                }

                res.send({
                    message: "Post deleted successfully",
                    deletedCount: result.deletedCount
                });

            } catch (err) {
                console.error("Delete post error:", err);

                res.status(500).send({
                    message: "Failed to delete post"
                });
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