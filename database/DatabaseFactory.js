const SQLiteAdapter = require("./adapters/SQLiteAdapter");
require("dotenv").config();

class DatabaseFactory {
  static createAdapter(type = null) {
    const dbType = type || process.env.DB_TYPE || "sqlite";

    switch (dbType.toLowerCase()) {
      case "sqlite":
        return new SQLiteAdapter({
          database: process.env.SQLITE_PATH || "./data/database.db",
        });

      default:
        throw new Error(`Unsupported database type: ${dbType}`);
    }
  }

  static async createAndConnect(type = null) {
    const adapter = this.createAdapter(type);
    await adapter.connect();
    return adapter;
  }
}

module.exports = DatabaseFactory;
