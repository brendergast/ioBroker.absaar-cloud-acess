'use strict';

const utils = require('@iobroker/adapter-core');
const axios = require('axios').default;
const https = require('https');

class MiniEMS extends utils.Adapter {
    constructor(options = {}) {
        super({
            ...options,
            name: 'mini-ems',
        });

        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        this.log.info('Adapter gestartet');

        this.username = this.config.username;
        this.password = this.config.password;
        this.stationIndex = parseInt(this.config.stationIndex) || 0;

        this.httpsAgent = new https.Agent({ rejectUnauthorized: false });
        this.BASE_URL = 'https://www.mini-ems.com:8081';

        this.updateInterval = 2 * 60 * 1000; // 2 Minuten

        await this.updateData();

        this.interval = setInterval(() => this.updateData(), this.updateInterval);
    }

    onUnload(callback) {
        try {
            if (this.interval) clearInterval(this.interval);
            callback();
        } catch (e) {
            this.log.error('Fehler beim Beenden: ' + e);
            callback();
        }
    }

    async login() {
        const url = `${this.BASE_URL}/dn/userLogin`;
        const headers = {
            'User-Agent': 'okhttp-okgo/jeasonlzy',
            'Content-Type': 'application/json;charset=utf-8',
        };

        try {
            const resp = await axios.post(url, {
                username: this.username,
                password: this.password
            }, { headers, httpsAgent: this.httpsAgent });

            if (resp.status === 200 && resp.data.token) {
                return { token: resp.data.token, userId: resp.data.userId };
            } else {
                this.log.error('Login fehlgeschlagen: ' + JSON.stringify(resp.data));
            }
        } catch (e) {
            this.log.error('Login-Fehler: ' + e.message);
        }

        return null;
    }

    async getStations(userId, token) {
        try {
            const resp = await axios.post(`${this.BASE_URL}/dn/power/station/listApp`,
                { userId: String(userId) },
                { headers: { Authorization: token }, httpsAgent: this.httpsAgent });

            return resp.data;
        } catch (e) {
            this.log.error('Fehler beim Abrufen der Stationen: ' + e.message);
        }

        return null;
    }

    async getCollectors(powerId, token) {
        try {
            const resp = await axios.post(`${this.BASE_URL}/dn/power/collector/listByApp`,
                { powerId },
                { headers: { Authorization: token }, httpsAgent: this.httpsAgent });

            return resp.data;
        } catch (e) {
            this.log.error('Fehler beim Abrufen der Kollektoren: ' + e.message);
        }

        return null;
    }

    async getInverterData(powerId, inverterId, token) {
        try {
            const resp = await axios.post(`${this.BASE_URL}/dn/power/inverterData/inverterDatalist`,
                { powerId, inverterId },
                { headers: { Authorization: token }, httpsAgent: this.httpsAgent });

            return resp.data;
        } catch (e) {
            this.log.error('Fehler beim Abrufen der Wechselrichterdaten: ' + e.message);
        }

        return null;
    }

    async updateData() {
        const creds = await this.login();
        if (!creds) return;

        const stations = await this.getStations(creds.userId, creds.token);
        if (!stations?.rows?.length) {
            this.log.warn('Keine Stationen gefunden.');
            return;
        }

        const station = stations.rows[this.stationIndex];
        const powerId = station.powerId;

        await this.setStateAsync(`station.${powerId}.totalPower`, { val: station.totalPowerGeneration, ack: true });
        await this.setStateAsync(`station.${powerId}.dailyPower`, { val: station.dailyPowerGeneration, ack: true });

        const collectors = await this.getCollectors(powerId, creds.token);
        if (!collectors?.rows) {
            this.log.warn(`Keine Collector‑Daten für Station ${station.powerName}`);
            return;
        }

        for (const col of collectors.rows) {
            const invData = await this.getInverterData(powerId, col.inverterId, creds.token);
            if (!invData?.rows?.[0]) {
                this.log.warn(`Keine Wechselrichterdaten für ${col.collectorName}`);
                continue;
            }

            const inv = invData.rows[0];
            const keys = [
                ['acPower','W'], ['acVoltage','V'], ['acFrequency','Hz'],
                ['pv1Power','W'], ['pv2Power','W'], ['temperature','C'],
                ['pv1Voltage','V'], ['pv1Electric','A'], ['pv2Voltage','V'],
                ['pv2Electric','A'], ['acElectric','A'], ['inPower','W']
            ];

            for (const [key, unit] of keys) {
                const id = `inv.${powerId}.${col.inverterId}.${key}`;
                await this.setObjectNotExistsAsync(id, {
                    type: 'state',
                    common: {
                        name: key,
                        type: 'number',
                        unit: unit,
                        role: 'value',
                        read: true,
                        write: false
                    },
                    native: {}
                });
                await this.setStateAsync(id, { val: inv[key] ?? 0, ack: true });
            }
        }
    }
}

if (require.main !== module) {
    module.exports = (options) => new MiniEMS(options);
} else {
    new MiniEMS();
}
