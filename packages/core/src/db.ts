import { DbConnection } from "@dibs/shared";
import { loadConfig } from "./config";

let connection: Promise<DbConnection> | undefined;

/**
 * One live SpacetimeDB connection per process, subscribed to every table. Once it resolves,
 * reads come from the local cache (`conn.db.intent.iter()`) and stay current on their own.
 */
export function db(): Promise<DbConnection> {
  connection ??= new Promise<DbConnection>((resolve, reject) => {
    const { spacetimeUri, spacetimeDb } = loadConfig();
    DbConnection.builder()
      .withUri(spacetimeUri)
      .withDatabaseName(spacetimeDb)
      .onConnect((conn) => {
        conn
          .subscriptionBuilder()
          .onApplied(() => resolve(conn))
          .onError(() => reject(new Error(`Couldn't subscribe to ${spacetimeDb}`)))
          .subscribeToAllTables();
      })
      .onConnectError((_ctx, error) => reject(error))
      .build();
  }).catch((error: unknown) => {
    connection = undefined;
    throw error;
  });
  return connection;
}
