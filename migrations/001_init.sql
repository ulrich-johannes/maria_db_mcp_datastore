-- Initial schema for the datastore-mcp state table.
-- The table name is configurable via the DB_TABLE env var; replace `mcp_state`
-- below if you are running this by hand against a different table name.

CREATE TABLE IF NOT EXISTS `mcp_state` (
  `var_name`     VARCHAR(255)  NOT NULL,
  `description`  VARCHAR(1000) NULL,
  `content`      LONGTEXT      NULL,
  `created`      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_updated` DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted`      TINYINT(1)    NOT NULL DEFAULT 0,
  PRIMARY KEY (`var_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
