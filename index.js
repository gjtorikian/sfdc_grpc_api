const grpc = require("@grpc/grpc-js");
const protoLoader = require("@grpc/proto-loader");
const fs = require("fs");
const jsforce = require("jsforce");
const avro = require("avro-js");
const certifi = require("certifi");
const { parseEvent } = require("./event-parser.js");

// Load config from .env file
require("dotenv").config();
const {
  SALESFORCE_LOGIN_URL,
  SALESFORCE_USERNAME,
  SALESFORCE_PASSWORD,
  SALESFORCE_TOKEN,
} = process.env;

const PUB_SUB_ENDPOINT = "api.pubsub.salesforce.com:7443";
const PUB_SUB_PROTO_FILE = "sfdc_pubsub_api.proto";
const PUB_SUB_TOPIC_NAME = "/data/ContactChangeEvent";

/**
 * Connects to Salesforce using jsForce
 * This is required to obtain an access token that the Pub/Sub API uses.
 * @returns the Salesforce connection
 */
async function connectToSalesforce() {
  const sfConnection = new jsforce.Connection({
    loginUrl: SALESFORCE_LOGIN_URL,
  });
  await sfConnection.login(
    SALESFORCE_USERNAME,
    SALESFORCE_PASSWORD + SALESFORCE_TOKEN
  );
  console.log(
    `Connected to Salesforce org ${sfConnection.instanceUrl} as ${SALESFORCE_USERNAME}`
  );
  return sfConnection;
}

/**
 * Connects to the Pub/Sub API and returns a gRPC client
 * @param {jsforce.Connection} sfConnection the Salesforce connection
 * @returns a gRPC client
 */
function connectToPubSubApi(sfConnection) {
  // Read certificates
  const rootCert = fs.readFileSync(certifi);

  // Load proto definition
  const packageDef = protoLoader.loadSync(PUB_SUB_PROTO_FILE, {});
  const grpcObj = grpc.loadPackageDefinition(packageDef);
  const sfdcPackage = grpcObj.eventbus.v1;

  // Prepare gRPC connection
  const metaCallback = (_params, callback) => {
    const meta = new grpc.Metadata();
    meta.add("accesstoken", sfConnection.accessToken);
    meta.add("instanceurl", sfConnection.instanceUrl);
    meta.add("tenantid", sfConnection.userInfo.organizationId);
    callback(null, meta);
  };
  const callCreds = grpc.credentials.createFromMetadataGenerator(metaCallback);
  const combCreds = grpc.credentials.combineChannelCredentials(
    grpc.credentials.createSsl(rootCert),
    callCreds
  );

  // Return pub/sub gRPC client
  const client = new sfdcPackage.PubSub(PUB_SUB_ENDPOINT, combCreds);
  console.log(`Pub/Sub API client is ready to connect`);
  return client;
}

/**
 * Requests the event schema for a topic
 * @param {Object} client Pub/Sub API gRPC client
 * @param {string} topicName name of the topic that we're fetching
 * @returns {Object} parsed event schema `{id: string, type: Object}`
 */
async function getEventSchema(client, topicName) {
  return new Promise((resolve, reject) => {
    client.GetTopic({ topicName }, (err, response) => {
      if (err) {
        // Handle error
        reject(err);
      } else {
        // Get the schema information
        const schemaId = response.schemaId;
        client.GetSchema({ schemaId }, (error, res) => {
          if (error) {
            // Handle error
            reject(err);
          } else {
            const schemaType = avro.parse(res.schemaJson);
            console.log(`Topic schema loaded: ${topicName}`);
            resolve({
              id: schemaId,
              type: schemaType,
            });
          }
        });
      }
    });
  });
}

/**
 * Subscribes to a topic using the gRPC client and an event schema
 * @param {Object} client Pub/Sub API gRPC client
 * @param {string} topicName name of the topic that we're subscribing to
 * @param {Object} schema event schema associated with the topic
 * @param {string} schema.id
 * @param {Object} schema.type
 */
function subscribe(client, topicName, schema) {
  const subscription = client.Subscribe(); //client here is the grpc client.
  // Since this is a stream, you can call the write method multiple times.
  // After the system has received the events == to numRequested, the stream ends.
  const subscribeRequest = {
    topicName,
    numRequested: 1,
  };
  subscription.write(subscribeRequest);
  console.log(
    `Subscribe request sent for ${subscribeRequest.numRequested} events from ${topicName}...`
  );

  // Listen to new events.
  subscription.on("data", (data) => {
    if (data.events) {
      const latestReplayId = data.latestReplayId.readBigUInt64BE();
      console.log(
        `Received ${data.events.length} events, latest replay ID: ${latestReplayId}`
      );
      const parsedEvents = data.events.map((event) =>
        parseEvent(schema, event)
      );
      console.log(
        "gRPC event payloads: ",
        JSON.stringify(parsedEvents, null, 2)
      );
    } else {
      // If there are no events then every 270 seconds the system will keep publishing the latestReplayId.
    }
  });
  subscription.on("end", () => {
    console.log("gRPC stream ended");
  });
  subscription.on("error", (err) => {
    // TODO: Handle errors
    console.error("gRPC stream error: ", JSON.stringify(err));
  });
  subscription.on("status", (status) => {
    console.log("gRPC stream status: ", status);
  });
}

/**
 * Publishes a payload to a topic using the gRPC client
 * @param {Object} client Pub/Sub API gRPC client
 * @param {string} topicName name of the topic that we're subscribing to
 * @param {Object} schema event schema associated with the topic
 * @param {string} schema.id
 * @param {Object} schema.type
 * @param {Object} payload
 */
/* eslint-disable no-unused-vars */
async function publish(client, topicName, schema, payload) {
  return new Promise((resolve, reject) => {
    console.log(topicName);
    client.Publish(
      {
        topicName: topicName,
        events: [
          {
            id: Date.now().toString(), // this can be any string
            schemaId: schema.id,
            payload: schema.type.toBuffer(payload),
          },
        ],
      },
      (err, response) => {
        if (err) {
          reject(err);
        } else {
          resolve(response);
        }
      }
    );
  });
}

async function run() {
  try {
    const sfConnection = await connectToSalesforce();
    const client = connectToPubSubApi(sfConnection);
    const topicSchema = await getEventSchema(client, PUB_SUB_TOPIC_NAME);

    const dataToPublish = {
      entityName: "Changed_Contact__e",
      Name__c: "A name",
      CreatedDate: new Date().getTime(),
      CreatedById: sfConnection.userInfo.id,
    };

    setTimeout(
      function publishEvent(payload) {
        publish(client, "/event/Changed_Contact__e", topicSchema, payload);
        console.log("Event published");
      },
      100,
      dataToPublish
    );

    subscribe(client, PUB_SUB_TOPIC_NAME, topicSchema);
  } catch (err) {
    console.error("Fatal error: ", err);
  }
}

run();
