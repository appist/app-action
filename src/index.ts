import { getInput, setFailed } from "@actions/core";
import { context, getOctokit } from "@actions/github";
import { PushEvent, PullRequestEvent } from "@octokit/webhooks-types/schema";
import { Deployment } from "@cloudflare/types";
import shellac from "shellac";
import { fetch } from "undici";

const AP_BASE_URL = "https://appist.io/api/v1";
const CF_BASE_URL = "https://api.cloudflare.com/client/v4";
const PREVIEW_COMMENT_PREFIX = "Preview URL:";

type Octokit = ReturnType<typeof getOctokit>;

interface DeploymentMeta {
	cloudflare: {
		accountId: string;
		apiToken: string;
		directory: string;
		productionBranch: string;
		projectName: string;
	};
}

async function getAppistDeploymentMeta(secretKey: string) {
	const response = await fetch(`${AP_BASE_URL}/application.deploymentMeta`, {
		body: JSON.stringify({
			secretKey,
		}),
		headers: {
			"Content-Type": "application/json",
		},
		method: "POST",
	});

	const {
		result: { data },
	} = (await response.json()) as { result: { data: DeploymentMeta | null } };

	return data;
}

async function deleteDeployments(
	branch: string,
	deploymentMeta: DeploymentMeta,
	deploymentKeeps: number,
) {
	const response = await fetch(
		`${CF_BASE_URL}/accounts/${deploymentMeta.cloudflare?.accountId}/pages/projects/${deploymentMeta.cloudflare?.projectName}/deployments`,
		{
			headers: {
				Authorization: `Bearer ${deploymentMeta.cloudflare?.apiToken}`,
			},
		},
	);
	const { result: deployments } = (await response.json()) as {
		result: Deployment[];
	};

	if (!deployments || deployments.length < 1) {
		return;
	}

	await Promise.all(
		deployments?.map(async (deployment, idx) => {
			try {
				if (
					deployment.deployment_trigger?.metadata?.branch !== branch ||
					idx < deploymentKeeps
				) {
					return;
				}

				await fetch(
					`${CF_BASE_URL}/accounts/${deploymentMeta.cloudflare?.accountId}/pages/projects/${deploymentMeta.cloudflare?.projectName}/deployments/${deployment.id}?force=true`,
					{
						method: "DELETE",
						headers: {
							Authorization: `Bearer ${deploymentMeta.cloudflare?.apiToken}`,
						},
					},
				);
			} catch (err) {
				console.error(err);
			}
		}),
	);
}

async function getCfDeployment(
	branch: string,
	commitHash: string,
	deploymentMeta: DeploymentMeta,
	environment: string,
) {
	const response = await fetch(
		`${CF_BASE_URL}/accounts/${deploymentMeta.cloudflare?.accountId}/pages/projects/${deploymentMeta.cloudflare?.projectName}/deployments`,
		{
			headers: {
				Authorization: `Bearer ${deploymentMeta.cloudflare?.apiToken}`,
			},
		},
	);
	const { result: deployments } = (await response.json()) as {
		result: Deployment[];
	};

	return deployments?.find(
		(deployment) =>
			deployment.environment === environment &&
			deployment.deployment_trigger.metadata.branch === branch &&
			deployment.deployment_trigger.metadata.commit_hash === commitHash,
	);
}

async function createDeployment(
	branch: string,
	commitHash: string,
	commitMessage: string,
	deploymentMeta: DeploymentMeta,
	octokit: Octokit,
	prNumber?: number,
) {
	const isProduction = branch === deploymentMeta.cloudflare?.productionBranch;
	const environment = isProduction ? "production" : "preview";
	const githubDeployment = await octokit.rest.repos.createDeployment({
		auto_merge: false,
		description: commitMessage,
		environment,
		owner: context.repo.owner,
		production_environment: isProduction,
		ref: branch,
		repo: context.repo.repo,
		required_contexts: [],
	});

	await shellac.in(process.cwd())`
    $ export CLOUDFLARE_ACCOUNT_ID="${deploymentMeta.cloudflare?.accountId}"
    $ export CLOUDFLARE_API_TOKEN="${deploymentMeta.cloudflare?.apiToken}"
    $$ ls -al
    $$ ./node_modules/.bin/wrangler pages publish ${deploymentMeta.cloudflare?.directory} --branch="${branch}" \
       --commit-hash="${commitHash}" --commit-message="${commitMessage}" \
       --project-name="${deploymentMeta.cloudflare?.projectName}"
  `;

	const cfDeployment = await getCfDeployment(
		branch,
		commitHash,
		deploymentMeta,
		environment,
	);

	if (githubDeployment?.status === 201) {
		await octokit.rest.repos.createDeploymentStatus({
			description: commitMessage,
			deployment_id: githubDeployment.data?.id,
			// @ts-expect-error
			environment,
			environment_url: cfDeployment?.url,
			owner: context.repo.owner,
			production_environment: isProduction,
			repo: context.repo.repo,
			state: "success",
		});
	}

	await deleteDeployments(branch, deploymentMeta, isProduction ? 2 : 1);

	if (prNumber) {
		const { data } = await octokit.rest.issues.listComments({
			issue_number: prNumber,
			owner: context.repo.owner,
			per_page: 100,
			repo: context.repo.repo,
		});

		let existingCommentId = -1;
		if (data?.length > 0) {
			data.map((comment) => {
				if (
					comment.body?.startsWith(PREVIEW_COMMENT_PREFIX) &&
					comment.user?.login === "github-actions[bot]" &&
					comment.user?.type.toLowerCase() === "bot"
				) {
					existingCommentId = comment.id;
				}
			});
		}

		if (existingCommentId > -1) {
			await octokit.rest.issues.updateComment({
				comment_id: existingCommentId,
				body: `${PREVIEW_COMMENT_PREFIX} [${cfDeployment?.url}](${cfDeployment?.url})`,
				issue_number: prNumber,
				owner: context.repo.owner,
				repo: context.repo.repo,
			});
		} else {
			await octokit.rest.issues.createComment({
				body: `${PREVIEW_COMMENT_PREFIX} [${cfDeployment?.url}](${cfDeployment?.url})`,
				issue_number: prNumber,
				owner: context.repo.owner,
				repo: context.repo.repo,
			});
		}
	}
}

async function run(): Promise<void> {
	try {
		const githubToken = getInput("githubToken", { required: true });
		const secretKey = getInput("secretKey", { required: true });
		const workingDirectory =
			getInput("workingDirectory", { required: false }) ?? ".";
		const octokit = getOctokit(githubToken);
		await shellac.in(process.cwd())`$$ cd ${workingDirectory}`;

		const secrets = await getAppistDeploymentMeta(secretKey);
		if (
			!(
				secrets?.cloudflare?.accountId &&
				secrets?.cloudflare?.apiToken &&
				secrets?.cloudflare?.directory &&
				secrets?.cloudflare?.projectName
			)
		) {
			throw new Error("Unable to retrieve the Appist's deployment meta.");
		}

		const { eventName, payload, ref, repo, sha } = context;

		switch (eventName) {
			case "push":
				const pushPayload = payload as PushEvent;
				await createDeployment(
					ref.replace("refs/heads/", ""),
					sha,
					pushPayload?.head_commit?.message || "",
					secrets,
					octokit,
				);

				break;

			case "pull_request":
				const prPayload = payload as PullRequestEvent;
				const { data } = await octokit.rest.pulls.listCommits({
					owner: repo.owner,
					repo: repo.repo,
					pull_number: prPayload.pull_request.number,
					per_page: 5,
				});

				switch (prPayload.action) {
					case "closed":
						await deleteDeployments(
							prPayload.pull_request.head.ref.replace("refs/heads/", ""),
							secrets,
							0,
						);

						break;

					case "opened":
					case "reopened":
					case "synchronize":
						await createDeployment(
							prPayload.pull_request.head.ref.replace("refs/heads/", ""),
							sha,
							data[0]?.commit?.message || "",
							secrets,
							octokit,
							prPayload.pull_request.number,
						);

						break;
				}

				break;
		}
	} catch (error) {
		setFailed((error as Error).message);
	}
}

run();
