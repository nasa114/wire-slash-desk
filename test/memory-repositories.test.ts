import { runFeedRepositoryContract } from './contract/feed-repository.contract.ts';
import { runArticleRepositoryContract } from './contract/article-repository.contract.ts';
import { runUserRepositoryContract } from './contract/user-repository.contract.ts';
import { runSessionRepositoryContract } from './contract/session-repository.contract.ts';
import { runOAuthRepositoriesContract } from './contract/oauth-repositories.contract.ts';
import { createMemoryRepositories } from '../src/repo/memory/index.ts';

const makeRepos = async () => createMemoryRepositories();

runFeedRepositoryContract('memory', makeRepos);
runArticleRepositoryContract('memory', makeRepos);
runUserRepositoryContract('memory', makeRepos);
runSessionRepositoryContract('memory', makeRepos);
runOAuthRepositoriesContract('memory', makeRepos);
