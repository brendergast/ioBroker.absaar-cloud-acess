"use strict";

/*
 * Created with @iobroker/create-adapter v2.6.5
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require("@iobroker/adapter-core");
let adapter;

// Load your modules here, e.g.:
// const fs = require("fs");
const axios = require("axios");
const { string } = require('voluptuous'); 
const BASE_URL = "https://mini-ems.com:8081";
const SCAN_INTERVAL = 2 * 60 * 1000; // in milliseconds


const PLATFORM_SCHEMA = PLATFORM_SCHEMA.extend({
    [CONF_USERNAME]: string().required(),
    [CONF_PASSWORD]: string().required(),
	});

const agent = new https.Agent({  
    rejectUnauthorized: false
});

class AbsaarCloudAcess extends utils.Adapter {

	/**
	 * @param {Partial<utils.AdapterOptions>} [options={}]
	 */
	constructor(options) {
		super({
			...options,
			name: "absaar-cloud-access",
		});
		this.on("ready", this.onReady.bind(this));
		this.on("stateChange", this.onStateChange.bind(this));
		// this.on("objectChange", this.onObjectChange.bind(this));
		// this.on("message", this.onMessage.bind(this));
		this.on("unload", this.onUnload.bind(this));
	}


	async function login(username, password) {
 		const url = `${BASE_URL}/dn/userLogin`;
		const headers = {
        		"User-Agent": "okhttp-okgo/jeasonlzy",
        		"Content-Type": "application/json;charset=utf-8",
    	};
    	const payload = { username, password };

    	try {
        	const response = await axios.post(url, payload, { headers, httpsAgent: agent });
        	const data = response.data;
        	if (response.status === 200 && data.token) {
            		return { token: data.token, userId: data.userId };
        	} else {
            		console.log("Login failed: %s", data);
            		return null;
        	}
    	} catch (error) {
        	console.log("Error during login: %s", error);
        	return null;
    }
	async function getStations(userId, token) {
    const url = `${BASE_URL}/dn/power/station/listApp`;
    const headers = { "Authorization": token };
    const payload = { userId: String(userId) };

    try {
        const response = await axios.post(url, payload, { headers, httpsAgent: agent });
        return response.data;
    } catch (error) {
        console.log("Error fetching stations: %s", error);
        return null;
    }
}

async function getCollectors(powerId, token) {
    const url = `${BASE_URL}/dn/power/collector/listByApp`;
    const headers = { "Authorization": token };
    const payload = { powerId: String(powerId) };

    try {
        const response = await axios.post(url, payload, { headers, httpsAgent: agent });
        return response.data;
    } catch (error) {
        console.log("Error fetching collectors: %s", error);
        return null;
    }
}

async function getInverterData(powerId, inverterId, token) {
    const url = `${BASE_URL}/dn/power/inverterData/inverterDatalist`;
    const headers = { "Authorization": token };
    const payload = { powerId, inverterId };

    try {
        const response = await axios.post(url, payload, { headers, httpsAgent: agent });
        return response.data;
    } catch (error) {
        console.log("Error fetching inverter data: %s", error);
        return null;
    }
}

let userId = "";

async function setupPlatform(hass, config, addEntities, discoveryInfo = null) {
    const username = config[CONF_USERNAME];
    const password = config[CONF_PASSWORD];

    const { token, userId: id } = await login(username, password);
    if (!token) {
        console.log("Authentication failed");
        return;
    }

    userId = id;
    const stations = await getStations(userId, token);
    if (!stations || !stations.rows) {
        console.log("No stations found");
        return;
    }

    const entities = [];
    for (const station of stations.rows) {
        const powerId = station.powerId;
        const dailyPower = station.dailyPowerGeneration;
        const totalPower = station.totalPowerGeneration;
        
        entities.push(new AbsaarStationSensor(`${station.powerName} totalPowerGeneration`, powerId, token, totalPower, "kWh"));
        entities.push(new AbsaarStationSensor(`${station.powerName} dailyPowerGeneration`, powerId, token, dailyPower, "kWh"));

        const collectors = await getCollectors(powerId, token);
        if (!collectors || !collectors.rows) {
            console.warn("No collectors found for station %s", station.powerName);
            continue;
        }

        for (const collector of collectors.rows) {
            const inverterId = collector.inverterId;
            const inverterData = await getInverterData(powerId, inverterId, token);
            if (!inverterData || !inverterData.rows || !inverterData.rows.length) {
                console.warn("No inverter data found for %s", collector.collectorName);
                continue;
            }

            const inverter = inverterData.rows[0];
            entities.push(new AbsaarInverterSensor(`${station.powerName} Power`, powerId, inverterId, token, "acPower", "W"));

            for (const [key, unit] of [
                ["acVoltage", "V"],
                ["acFrequency", "Hz"],
                ["pv1Power", "W"],
                ["pv2Power", "W"],
                ["temperature", "C"],
                ["pv1Voltage", "V"],
                ["pv1Electric", "A"],
                ["pv2Voltage", "V"],
                ["pv2Electric", "A"],
                ["acElectric", "A"],
                ["inPower", "W"],
            ]) {
                entities.push(new AbsaarInverterSensor(`${station.powerName} ${key}`, powerId, inverterId, token, key, unit));
            }
        }
    }

    addEntities(entities, true);
}

class AbsaarInverterSensor extends SensorEntity {
    constructor(name, powerId, inverterId, token, sensorKey, unit) {
        super();
        this._powerId = powerId;
        this._inverterId = inverterId;
        this._token = token;
        this._sensorKey = sensorKey;

        this._attr_name = name;
        this._attr_native_unit_of_measurement = unit;
        this._attr_device_class = this._inferDeviceClass(unit);
        this._attr_state_class = SensorStateClass.MEASUREMENT;
        this._attr_extra_state_attributes = {};
    }

    _inferDeviceClass(unit) {
        return {
            "W": "power",
            "V": "voltage",
            "A": "current",
            "°C": "temperature",
            "Hz": "frequency"
        }[unit];
    }

    async update() {
        const data = await getInverterData(this._powerId, this._inverterId, this._token);

        if (!data || !data.rows || !data.rows.length) {
            console.warn("No inverter data received for ID %s", this._inverterId);
            this._attr_native_value = "No Data";
            return;
        }

        const inverter = data.rows[0];
        this._attr_native_value = inverter[this._sensorKey] || 0.0;
    }
}

class AbsaarStationSensor extends SensorEntity {
    constructor(name, powerId, token, value, unit) {
        super();
        this._powerId = powerId;
        this._token = token;
        this._attr_name = name;
        this._attr_native_unit_of_measurement = unit;
        this._attr_native_value = value;
        this._attr_device_class = unit === "kWh" ? SensorDeviceClass.ENERGY : null;
        this._attr_state_class = unit === "kWh" ? SensorStateClass.TOTAL_INCREASING : null;
        this._attr_extra_state_attributes = {};
    }

    async update() {
        const data = await getStations(userId, this._token);

        if (!data || !data.rows || !data.rows.length) {
            console.warn("No station data received for ID %s", this._powerId);
            this._attr_native_value = "No Data";
            return;
        }

        const station = data.rows[0];
        this._attr_native_value = station.dailyPowerGeneration || 0.0;
    }
}
	
	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {
		// Initialize your adapter here

		// The adapters config (in the instance object everything under the attribute "native") is accessible via
		// this.config:
		this.log.info("config user: " + this.config.user);
		this.log.info("config password: " + this.config.password);

		/*
		For every state in the system there has to be also an object of type state
		Here a simple template for a boolean variable named "testVariable"
		Because every adapter instance uses its own unique namespace variable names can't collide with other adapters variables
		*/
		await this.setObjectNotExistsAsync("testVariable", {
			type: "state",
			common: {
				name: "testVariable",
				type: "boolean",
				role: "indicator",
				read: true,
				write: true,
			},
			native: {},
		});

		// In order to get state updates, you need to subscribe to them. The following line adds a subscription for our variable we have created above.
		this.subscribeStates("testVariable");
		// You can also add a subscription for multiple states. The following line watches all states starting with "lights."
		// this.subscribeStates("lights.*");
		// Or, if you really must, you can also watch all states. Don't do this if you don't need to. Otherwise this will cause a lot of unnecessary load on the system:
		// this.subscribeStates("*");

		/*
			setState examples
			you will notice that each setState will cause the stateChange event to fire (because of above subscribeStates cmd)
		*/
		// the variable testVariable is set to true as command (ack=false)
		await this.setStateAsync("testVariable", true);

		// same thing, but the value is flagged "ack"
		// ack should be always set to true if the value is received from or acknowledged from the target system
		await this.setStateAsync("testVariable", { val: true, ack: true });

		// same thing, but the state is deleted after 30s (getState will return null afterwards)
		await this.setStateAsync("testVariable", { val: true, ack: true, expire: 30 });

		// examples for the checkPassword/checkGroup functions
		let result = await this.checkPasswordAsync("admin", "iobroker");
		this.log.info("check user admin pw iobroker: " + result);

		result = await this.checkGroupAsync("admin", "admin");
		this.log.info("check group user admin group admin: " + result);
	}

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 * @param {() => void} callback
	 */
	onUnload(callback) {
		try {
			// Here you must clear all timeouts or intervals that may still be active
			// clearTimeout(timeout1);
			// clearTimeout(timeout2);
			// ...
			// clearInterval(interval1);

			callback();
		} catch (e) {
			callback();
		}
	}

	// If you need to react to object changes, uncomment the following block and the corresponding line in the constructor.
	// You also need to subscribe to the objects with `this.subscribeObjects`, similar to `this.subscribeStates`.
	// /**
	//  * Is called if a subscribed object changes
	//  * @param {string} id
	//  * @param {ioBroker.Object | null | undefined} obj
	//  */
	// onObjectChange(id, obj) {
	// 	if (obj) {
	// 		// The object was changed
	// 		this.log.info(`object ${id} changed: ${JSON.stringify(obj)}`);
	// 	} else {
	// 		// The object was deleted
	// 		this.log.info(`object ${id} deleted`);
	// 	}
	// }

	/**
	 * Is called if a subscribed state changes
	 * @param {string} id
	 * @param {ioBroker.State | null | undefined} state
	 */
	onStateChange(id, state) {
		if (state) {
			// The state was changed
			this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
		} else {
			// The state was deleted
			this.log.info(`state ${id} deleted`);
		}
	}

	// If you need to accept messages in your adapter, uncomment the following block and the corresponding line in the constructor.
	// /**
	//  * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
	//  * Using this method requires "common.messagebox" property to be set to true in io-package.json
	//  * @param {ioBroker.Message} obj
	//  */
	// onMessage(obj) {
	// 	if (typeof obj === "object" && obj.message) {
	// 		if (obj.command === "send") {
	// 			// e.g. send email or pushover or whatever
	// 			this.log.info("send command");

	// 			// Send response in callback if required
	// 			if (obj.callback) this.sendTo(obj.from, obj.command, "Message received", obj.callback);
	// 		}
	// 	}
	// }

}

if (require.main !== module) {
	// Export the constructor in compact mode
	/**
	 * @param {Partial<utils.AdapterOptions>} [options={}]
	 */
	module.exports = (options) => new AbsaarCloudAcess(options);
} else {
	// otherwise start the instance directly
	new AbsaarCloudAcess();
}
