'use strict';

const utils = require('@iobroker/adapter-core');
const axios = require('axios').default;
const https = require('https');

class MiniEMS extends utils.Adapter {
    constructor(options) {
        super({
            ...options,
            name: 'mini-ems'
        });

        this.BASE_URL = 'https://www.mini-ems.com:8081';
        this.httpsAgent = new https.Agent({ rejectUnauthorized: false });

        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));

        this.updateInterval = null;
    }

    async onReady() {
        try {
            // Konfiguration aus ioBroker Admin
            this.username = this.config.username;
            this.password = this.config.password;
            this.stationIndex = parseInt(this.config.stationIndex) || 0;

            if (!this.username || !this.password) {
                this.log.error('Benutzername oder Passwort in den Adapter-Einstellungen fehlt!');
                return;
            }

            // Direkt starten und dann periodisch wiederholen
            await this.updateData();
            this.updateInterval = setInterval(() => this.updateData(), 2 * 60 * 1000);

        } catch (err) {
            this.log.error(`Fehler beim Start: ${err.message}`);
        }
    }

    async login(username, password) {
        const url = `${this.BASE_URL}/dn/userLogin`;
        const headers = {
            'User-Agent': 'okhttp-okgo/jeasonlzy',
            'Content-Type': 'application/json;charset=utf-8',
        };

        try {
            const resp = await axios.post(url, { username, password }, { headers, httpsAgent: this.httpsAgent });
            if (resp.status === 200 && resp.data.token) {
                return { token: resp.data.token, userId: resp.data.userId };
            } else {
                this.log.error('Login fehlgeschlagen: ' + JSON.stringify(resp.data));
            }
        } catch (e) {
            this.log.error(`Login-Fehler: ${e.message}`);
        }
        return null;
    }

    async getStations(userId, token) {
        const url = `${this.BASE_URL}/dn/power/station/listApp`;
        const headers = { Authorization: token };
        const payload = { userId: String(userId) };

        try {
            const resp = await axios.post(url, payload, { headers, httpsAgent: this.httpsAgent });
            return resp.data;
        } catch (e) {
            this.log.error('Fehler beim Abrufen der Stationen: ' + e.message);
        }
        return null;
    }

    async getCollectors(powerId, token) {
        const url = `${this.BASE_URL}/dn/power/collector/listByApp`;
        const headers = { Authorization: token };
        try {
            const resp = await axios.post(url, { powerId }, { headers, httpsAgent: this.httpsAgent });
            return resp.data;
        } catch (e) {
            this.log.error('Fehler beim Abrufen der Collector-Daten: ' + e.message);
        }
        return null;
    }

    async getInverterData(powerId, inverterId, token) {
        const url = `${this.BASE_URL}/dn/power/inverterData/inverterDatalist`;
        const headers = { Authorization: token };
        try {
            const resp = await axios.post(url, { powerId, inverterId }, { headers, httpsAgent: this.httpsAgent });
            return resp.data;
        } catch (e) {
            this.log.error('Fehler beim Abrufen der Inverter-Daten: ' + e.message);
        }
        return null;
    }

    async updateData() {
        try {
            const creds = await this.login(this.username, this.password);
            if (!creds) return;

            const stations = await this.getStations(creds.userId, creds.token);
            if (!stations || !stations.rows || stations.rows.length === 0) {
                this.log.warn('Keine Stationen gefunden');
                return;
            }

            const station = stations.rows[this.stationIndex];
            if (!station) {
                this.log.error(`Station mit Index ${this.stationIndex} existiert nicht`);
                return;
            }

            const powerId = station.powerId;

            await this.setStateValue(`station.${powerId}.totalPower`, station.totalPowerGeneration);
            await this.setStateValue(`station.${powerId}.dailyPower`, station.dailyPowerGeneration);

            const collectors = await this.getCollectors(powerId, creds.token);
            if (!collectors || !collectors.rows) {
                this.log.warn(`Keine Collector-Daten für Station ${station.powerName}`);
                return;
            }

            // Alle Inverter parallel abfragen
            await Promise.all(
                collectors.rows.map(async (col) => {
                    const invData = await this.getInverterData(powerId, col.inverterId, creds.token);
                    if (!invData || !invData.rows || !invData.rows[0]) {
                        this.log.warn(`Keine Inverter-Daten für Collector ${col.collectorName}`);
                        return;
                    }
                    const inv = invData.rows[0];
                    const keys = [
                        'acPower', 'acVoltage', 'acFrequency',
                        'pv1Power', 'pv2Power', 'temperature',
                        'pv1Voltage', 'pv1Electric', 'pv2Voltage',
                        'pv2Electric', 'acElectric', 'inPower'
                    ];
                    for (const key of keys) {
                        await this.setStateValue(`inv.${powerId}.${col.inverterId}.${key}`, inv[key] ?? 0);
                    }
                })
            );

        } catch (err) {
            this.log.error(`updateData Fehler: ${err.message}`);
        }
    }

    async setStateValue(id, value) {
        await this.setObjectNotExistsAsync(id, {
            type: 'state',
            common: {
                name: id,
                type: typeof value === 'number' ? 'number' : 'string',
                role: 'value',
                read: true,
                write: false
            },
            native: {}
        });
        await this.setStateAsync(id, { val: value, ack: true });
    }

    onUnload(callback) {
        try {
            if (this.updateInterval) {
                clearInterval(this.updateInterval);
            }
            callback();
        } catch (e) {
            callback();
        }
    }
}

if (require.main !== module) {
    module.exports = (options) => new MiniEMS(options);
} else {
    new MiniEMS();
}
