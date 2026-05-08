-- Make the circular FKs between accounts and users DEFERRABLE so that
-- createBusinessTx can INSERT accounts (referencing a not-yet-existing
-- user) before INSERTing the user row, within a single transaction.

ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_owner_user_id_fkey;
ALTER TABLE accounts ADD CONSTRAINT accounts_owner_user_id_fkey
  FOREIGN KEY (owner_user_id) REFERENCES users(id)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE users DROP CONSTRAINT IF EXISTS fk_users_account;
ALTER TABLE users ADD CONSTRAINT fk_users_account
  FOREIGN KEY (account_id) REFERENCES accounts(id)
  DEFERRABLE INITIALLY DEFERRED;
