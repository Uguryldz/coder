-- Bootstrap databases for Orkestra stack
CREATE USER orkestra WITH PASSWORD 'orkestra' SUPERUSER;
CREATE DATABASE orkestra OWNER orkestra;

CREATE USER temporal WITH PASSWORD 'temporal';
CREATE DATABASE temporal OWNER temporal;
CREATE DATABASE temporal_visibility OWNER temporal;

-- For optional Jira DC / Bitbucket integration test containers
CREATE USER jira WITH PASSWORD 'jira';
CREATE DATABASE jira OWNER jira;

CREATE USER bitbucket WITH PASSWORD 'bitbucket';
CREATE DATABASE bitbucket OWNER bitbucket;
